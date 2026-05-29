import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { LoroDoc, UndoManager } from 'loro-crdt'
import { exportToBlob, CaptureUpdateAction, restoreElements } from '@excalidraw/excalidraw'
import { commitAfterUpload } from '../lib/commit-pipeline.js'
import { apiFetch } from '../lib/api-client.js'
import { resolveParentedElements } from '../../shared/resolve-parented-elements.js'
import {
  applyRestoreComplete,
  buildWhiteboardWsProtocols,
  buildWhiteboardWsUrl,
  flushPendingExportRequests,
  handleIncomingExportRequest,
} from './useWhiteboardSync.helpers.js'
import { parseServerTextMessage } from './useWhiteboardSync.text-message.js'
import type {
  ExportRequestMessage,
  VersionCreatedPayload,
} from '../../shared/ws-messages.js'
import type {
  ExcalidrawImperativeAPI,
  BinaryFileData,
  BinaryFiles,
  DataURL,
} from '@excalidraw/excalidraw/types'
import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  FileId,
} from '@excalidraw/excalidraw/element/types'

// Small debounce helper with no external dependency.
function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  ms: number,
): T & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const debounced = (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      fn(...args)
      timer = null
    }, ms)
  }
  debounced.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return debounced as T & { cancel: () => void }
}

// Blob -> base64 helper.
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

export interface UseWhiteboardSyncOptions {
  // Called right after auto-save creates a version, typically to upload a thumbnail.
  // It is stored in a ref, so it does not need to sit in effect dependency arrays.
  onVersionCreated?: (version: VersionCreatedPayload) => void
  // Called when a file (image) upload fails and the canvas commit is skipped.
  onFileUploadFailed?: () => void
  // Called after a successful file upload, allowing callers to clear a previous error.
  onFileUploadSucceeded?: () => void
}

export function applyHydratedSceneToApi(args: {
  api: Pick<ExcalidrawImperativeAPI, 'addFiles' | 'updateScene'>
  elements: ExcalidrawElement[]
  files: BinaryFileData[]
}): void {
  args.api.addFiles(args.files)
  const restoredElements = restoreElements(args.elements, null, {
    repairBindings: true,
  })
  args.api.updateScene({
    elements: restoredElements,
    captureUpdate: CaptureUpdateAction.NEVER,
  })
}

export function useWhiteboardSync(
  workspaceId: string,
  slug: string,
  options: UseWhiteboardSyncOptions = {},
) {
  const excalidrawAPIRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const docRef = useRef<LoroDoc | null>(null)
  const undoManagerRef = useRef<UndoManager | null>(null)
  const [apiReady, setApiReady] = useState(false)

  // Keep callbacks in refs so effects do not reconnect when the caller re-renders with new function identities.
  const onVersionCreatedRef = useRef(options.onVersionCreated)
  onVersionCreatedRef.current = options.onVersionCreated
  const onFileUploadFailedRef = useRef(options.onFileUploadFailed)
  onFileUploadFailedRef.current = options.onFileUploadFailed
  const onFileUploadSucceededRef = useRef(options.onFileUploadSucceeded)
  onFileUploadSucceededRef.current = options.onFileUploadSucceeded

  // Soft-lock state used while another peer is restoring. CanvasPage shows an overlay and blocks input.
  // label is optional; a generic message is used when it is absent.
  const [restoreInProgress, setRestoreInProgress] = useState(false)
  const [restoreLabel, setRestoreLabel] = useState<string | null>(null)

  // Image file cache keyed by fileId.
  const filesCacheRef = useRef<Record<string, BinaryFileData>>({})

  // Track uploaded files so browser-added images are not PUT twice.
  const uploadedFileIdsRef = useRef<Set<string>>(new Set())
  const pendingExportRequestsRef = useRef<ExportRequestMessage[]>([])

  // Generation counter for async apply work.
  // Never reset back to 0; monotonic increments prevent collisions with in-flight work from older canvases.
  const applyGenerationRef = useRef(0)

  function notifyClientReady(): void {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !excalidrawAPIRef.current) return
    ws.send(JSON.stringify({ type: 'client_ready' }))
  }

  // Excalidraw API callback.
  const onApiReady = useCallback((api: ExcalidrawImperativeAPI) => {
    excalidrawAPIRef.current = api
    setApiReady(true)
    notifyClientReady()
    void flushPendingExportRequests({
      api,
      pending: pendingExportRequestsRef.current,
      send: (message) => wsRef.current?.send(message),
      exportToBlobFn: exportToBlob,
      blobToBase64Fn: blobToBase64,
    })
  }, [])

  // Apply the current Loro-derived scene into Excalidraw, including image file hydration.
  async function applyLoroToExcalidraw(doc: LoroDoc) {
    const generation = ++applyGenerationRef.current
    // Re-resolve annotations saved with coords:'parent' against the latest parent position.
    // This keeps them aligned even if a parent moves between snapshot fetch and update POST.
    // resolveParentedElements converts parentId/relX/relY into absolute x/y coordinates Excalidraw understands.
    //
    // Dual-read legacy support:
    // older canvases stored "elements" in a LoroList, while current code writes to MovableList.
    // If MovableList is empty, fall back to List so legacy data still loads.
    const movable = doc.getMovableList('elements').toJSON() as ExcalidrawElement[]
    const rawElements: ExcalidrawElement[] = movable.length > 0
      ? movable
      : (doc.getList('elements').toJSON() as ExcalidrawElement[])
    const elements = resolveParentedElements(
      rawElements as unknown as Parameters<typeof resolveParentedElements>[0],
    ) as unknown as ExcalidrawElement[]

    // Collect fileIds that are still missing from the local cache.
    const missingIds = elements
      .filter(
        (el): el is ExcalidrawImageElement =>
          el.type === 'image' &&
          !!(el as ExcalidrawImageElement).fileId &&
          !filesCacheRef.current[(el as ExcalidrawImageElement).fileId!],
      )
      .map((el) => el.fileId!)

    // Fetch missing files in parallel. Individual failures are ignored.
    await Promise.allSettled(
      missingIds.map(async (fileId) => {
        const res = await apiFetch(`/api/canvas/${workspaceId}/${encodeURIComponent(slug)}/file/${fileId}`)
        if (!res.ok) return
        const blob = await res.blob()
        const dataURL = await blobToBase64(blob)
        filesCacheRef.current[fileId] = {
          id: fileId as FileId,
          mimeType: blob.type as BinaryFileData['mimeType'],
          dataURL: dataURL as DataURL,
          created: Date.now(),
        }
      }),
    )

    // Recheck the generation after async fetch work finishes.
    if (generation !== applyGenerationRef.current) return

    const api = excalidrawAPIRef.current
    if (!api) return

    applyHydratedSceneToApi({
      api,
      elements,
      files: Object.values(filesCacheRef.current),
    })
  }

  // Reset document-scoped state when switching canvases.
  useEffect(() => {
    docRef.current = null
    undoManagerRef.current = null
    filesCacheRef.current = {}
    uploadedFileIdsRef.current = new Set()
    pendingExportRequestsRef.current = []
    applyGenerationRef.current += 1 // never reset this back to 0
  }, [workspaceId, slug])

  // WebSocket connection plus Loro initialization.
  // Reconnect with exponential backoff (500ms -> 8s) when ws.onclose fires.
  // This covers suspend, temporary network drops, and daemon restarts so the browser does not stay open
  // with a dead websocket and immediate no_client export failures.
  useEffect(() => {
    let cancelled = false
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    const daemonToken = window.__WHITEBOARD_RUNTIME_CONFIG__?.daemonToken ?? null

    const connect = () => {
      if (cancelled) return
      const ws = new WebSocket(
        buildWhiteboardWsUrl(window.location.href, workspaceId, slug),
        buildWhiteboardWsProtocols(daemonToken),
      )
      // Required: without this, binary frames arrive as Blob and the ArrayBuffer check fails.
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws
      ws.onopen = () => {
        attempt = 0
        notifyClientReady()
      }
      ws.onclose = () => {
        if (cancelled) return
        // 500ms, 1s, 2s, 4s, 8s, 8s, ... capped at 8s.
        const delay = Math.min(8000, 500 * 2 ** attempt)
        attempt += 1
        reconnectTimer = setTimeout(connect, delay)
      }
      ws.onerror = () => {
          // Browsers usually also fire close here, but force it just in case so reconnect logic runs.
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      }

      ws.onmessage = async (event) => {
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data)

        if (!docRef.current) {
          // First binary message: initialize LoroDoc from the snapshot.
          const doc = LoroDoc.fromSnapshot(bytes)
          docRef.current = doc
          undoManagerRef.current = new UndoManager(doc, { mergeInterval: 500 })

          // Send local Loro updates back through the websocket.
          doc.subscribeLocalUpdates((update) => {
            wsRef.current?.send(update.slice())
          })

          // Update Excalidraw when remote imports land.
          doc.subscribe((e) => {
            if (e.by === 'import') {
              applyLoroToExcalidraw(doc)
            }
            // Emit doc_changed for both local and remote edits so useDirtyState can track dirty state.
            // Skip the initial snapshot checkout because that state is still pristine.
            if (e.by === 'local' || e.by === 'import') {
              if (typeof window !== 'undefined') {
                window.dispatchEvent(
                  new CustomEvent('excalidraw:doc_changed', {
                    detail: { workspaceId, slug },
                  }),
                )
              }
            }
          })

          // Always try to apply the first snapshot immediately.
          // Gating this behind apiReady caused a stale-closure bug where the canvas stayed visually empty.
          // If the API is not ready yet, updateScene is simply a no-op and the later apiReady effect reapplies.
          applyLoroToExcalidraw(doc)
        } else {
          // Incremental update.
          docRef.current.import(bytes)
          // applyLoroToExcalidraw runs from the doc.subscribe "import" handler above.
        }
      } else if (typeof event.data === 'string') {
        const msg = parseServerTextMessage(event.data)
        if (!msg) return
        if (msg.type === 'version_created' && msg.version) {
          // When the server creates an auto-version, let the caller generate and upload the thumbnail.
          // This hook stays focused on websocket coordination.
          onVersionCreatedRef.current?.(msg.version)
          // Any new version, auto or manual, marks the document clean for useDirtyState.
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('excalidraw:version_saved', {
                detail: { workspaceId, slug },
              }),
            )
          }
          return
        }
        if (msg.type === 'restore_started') {
          setRestoreInProgress(true)
          setRestoreLabel(msg.label ?? null)
          return
        }
        if (msg.type === 'restore_complete') {
          applyRestoreComplete({
            setRestoreInProgress,
            setRestoreLabel,
            clearLocalUndo: () => undoManagerRef.current?.clear(),
          })
          return
        }
        if (msg.type === 'head_changed') {
          // HEAD switch signal:
          // - emit the CustomEvent that useBranches listens to
          // - keep useBranches as the source of truth for current HEAD UI
          // - scene content already follows through the regular Loro broadcast path
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('excalidraw:head_changed', {
                detail: { workspaceId, slug, head: msg.head },
              }),
            )
          }
          return
        }
        if (msg.type === 'viewport_request') {
          const api = excalidrawAPIRef.current
          // Reply with an ACK even when the API is not ready so callers treat this as a soft miss, not a timeout.
          if (api) {
            const mode = msg.mode ?? 'fit'
            if (mode === 'fit') {
              const all = api.getSceneElements()
              // If elementIds are provided, fit only those. Otherwise use the full scene.
              const target =
                msg.elementIds !== undefined
                  ? all.filter((el) => msg.elementIds!.includes(el.id))
                  : all
              // fitToContent also adjusts zoom.
              // Skip empty targets because some implementations mis-handle zoom for empty arrays.
              if (target.length > 0) {
                api.scrollToContent(target, {
                  fitToContent: true,
                  animate: msg.animate ?? true,
                })
              }
            } else if (mode === 'move') {
              const appState = api.getAppState()
              // AppState.zoom.value is a branded NormalizedZoomValue and AppState itself is readonly,
              // so rebuild a mutable object before writing plain numeric values into it.
              type MutableAppState = {
                -readonly [K in keyof typeof appState]: (typeof appState)[K]
              }
              const merged: MutableAppState = { ...appState }
              if (msg.scrollX !== undefined) merged.scrollX = msg.scrollX
              if (msg.scrollY !== undefined) merged.scrollY = msg.scrollY
              if (msg.zoom !== undefined) {
                merged.zoom = {
                  value: msg.zoom as unknown as typeof appState.zoom.value,
                }
              }
              api.updateScene({
                appState: merged,
                captureUpdate: CaptureUpdateAction.NEVER,
              })
            }
          }
          ws.send(
            JSON.stringify({ type: 'viewport_response', requestId: msg.requestId }),
          )
          return
        }
        if (msg.type === 'export_request') {
          await handleIncomingExportRequest(
            msg as ExportRequestMessage,
            {
              api: excalidrawAPIRef.current,
              pending: pendingExportRequestsRef.current,
              send: (message) => ws.send(message),
              exportToBlobFn: exportToBlob,
              blobToBase64Fn: blobToBase64,
            },
          )
        }
      }
    }
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      wsRef.current?.close()
    }
  }, [workspaceId, slug]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reapply the current document once the Excalidraw API becomes ready.
  useEffect(() => {
    if (!apiReady || !docRef.current) return
    notifyClientReady()
    void flushPendingExportRequests({
      api: excalidrawAPIRef.current,
      pending: pendingExportRequestsRef.current,
      send: (message) => wsRef.current?.send(message),
      exportToBlobFn: exportToBlob,
      blobToBase64Fn: blobToBase64,
    })
    applyLoroToExcalidraw(docRef.current)
  }, [apiReady]) // eslint-disable-line react-hooks/exhaustive-deps

  // Record Excalidraw changes into Loro and upload any new files.
  // Memoize the debounced callback by canvas key so swapping canvases swaps
  // the closure (which captures workspaceId / slug) without mutating refs in
  // render. React is allowed to discard a useMemo result; the worst case is a
  // fresh 300ms window for the new closure, never a write into the wrong doc,
  // because the closure still uses the same workspaceId / slug.
  const canvasKey = `${workspaceId}/${slug}`
  const onSceneChange = useMemo(() => {
    return debounce((elements: ExcalidrawElement[], files: BinaryFiles) => {
      // Capture doc at invocation time.
      // Looking at docRef.current after async upload work could write canvas A's elements into canvas B's doc.
      const doc = docRef.current
      if (!doc) return

      const newEntries = Object.entries(files).filter(
        ([fileId, fd]) => fd && !uploadedFileIdsRef.current.has(fileId),
      ) as [string, BinaryFileData][]

      // commitAfterUpload commits immediately when there are no new files, otherwise waits for uploads.
      // On upload failure it rejects and skips the commit.
      commitAfterUpload(
        newEntries,
        doc, // pass the invocation-time captured reference
        elements,
        workspaceId,
        slug,
        (fileId) => uploadedFileIdsRef.current.add(fileId),
      ).then(() => {
        if (newEntries.length > 0) onFileUploadSucceededRef.current?.()
      }).catch((err: unknown) => {
        console.error('[whiteboard] file upload failed, commit skipped:', err)
        onFileUploadFailedRef.current?.()
      })
    }, 300)
    // canvasKey already encodes workspaceId/slug, but listing both keeps the
    // exhaustive-deps rule honest with the closure's captured values.
  }, [canvasKey, workspaceId, slug])

  // Cancel the previous debounce whenever the memoized callback changes
  // (canvas key switch) and on unmount, so a pending 300ms timer cannot leak
  // into a new canvas's doc or fire against a torn-down hook.
  useEffect(() => {
    return () => {
      onSceneChange.cancel()
    }
  }, [onSceneChange])

  // Wire LoroUndoManager into Excalidraw's keyboard shortcuts and undo/redo buttons.
  // This avoids Excalidraw's built-in undo rolling back remote collaboration edits.
  // LoroUndoManager only stores commits from the local peer, which is the safer behavior here.
  //
  // Known limitation:
  // server-side MCP edits arrive as remote imports, so they are not added to the browser UndoManager.
  // Ctrl+Z only reverts GUI edits made in this browser session.
  const loroUndo = useCallback(() => {
    const um = undoManagerRef.current
    const doc = docRef.current
    if (!um || !doc) return false
    if (!um.canUndo()) return false
    um.undo()
    // applyLoroToExcalidraw is async, but we intentionally do not await it so undo feels immediate.
    // applyGenerationRef prevents collisions with in-flight apply work from another canvas.
    void applyLoroToExcalidraw(doc)
    return true
  }, [])
  const loroRedo = useCallback(() => {
    const um = undoManagerRef.current
    const doc = docRef.current
    if (!um || !doc) return false
    if (!um.canRedo()) return false
    um.redo()
    void applyLoroToExcalidraw(doc)
    return true
  }, [])

  useEffect(() => {
    // Do not intercept Ctrl+Z while text editing is active inside Excalidraw.
    // Stealing the key during IME composition can corrupt text before it is committed.
    function isEditingText(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return true
      if (target.isContentEditable) return true
      return false
    }

    function onKeyDown(ev: KeyboardEvent): void {
      if (!(ev.ctrlKey || ev.metaKey)) return
      if (isEditingText(ev.target)) return
      // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y = redo.
      const key = ev.key.toLowerCase()
      if (key === 'z' && !ev.shiftKey) {
        if (loroUndo()) {
          ev.preventDefault()
          ev.stopPropagation()
        }
      } else if ((key === 'z' && ev.shiftKey) || key === 'y') {
        if (loroRedo()) {
          ev.preventDefault()
          ev.stopPropagation()
        }
      }
    }

    function onPointerDown(ev: PointerEvent): void {
      if (!(ev.target instanceof Element)) return
      // Identify the Excalidraw toolbar undo/redo buttons by data-testid and ignore nearby controls.
      const btn = ev.target.closest('[data-testid="button-undo"], [data-testid="button-redo"]')
      if (!btn) return
      const testid = btn.getAttribute('data-testid')
      if (testid === 'button-undo') {
        if (loroUndo()) {
          ev.preventDefault()
          ev.stopPropagation()
        }
      } else if (testid === 'button-redo') {
        if (loroRedo()) {
          ev.preventDefault()
          ev.stopPropagation()
        }
      }
    }

    // capture:true lets this run before Excalidraw's internal handlers.
    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions)
      window.removeEventListener(
        'pointerdown',
        onPointerDown,
        { capture: true } as EventListenerOptions,
      )
    }
  }, [loroUndo, loroRedo])

  // Clear the per-peer undo stack after restore.
  // Once the canvas jumps to an older state, the previous local edit history is no longer meaningful.
  const clearLocalUndo = useCallback(() => {
    undoManagerRef.current?.clear()
  }, [])

  return {
    onApiReady,
    onSceneChange,
    loroUndo,
    loroRedo,
    clearLocalUndo,
    restoreInProgress,
    restoreLabel,
  }
}
