import { CaptureUpdateAction, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, FileId } from '@excalidraw/excalidraw/element/types'
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  DataURL,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'
import type { CanvasBackend } from '@kamiazya/whiteboard-mcp/browser-contract'
import {
  resolveParentedElements,
  validateLoroRawElements,
} from '@kamiazya/whiteboard-mcp/browser-shared'
import type { Value } from 'loro-crdt'
import { LoroDoc, LoroMap, UndoManager } from 'loro-crdt'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type SyncStatus = 'idle' | 'connected' | 'error'

export interface UseCanvasSyncResult {
  syncStatus: SyncStatus
  setExcalidrawAPI: (api: ExcalidrawImperativeAPI) => void
  onChange: (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => void
}

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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/**
 * useCanvasSync — browser-local port of useWhiteboardSync.
 *
 * Accepts a CanvasBackend (e.g. BrowserLocalBackend) or null when no backend
 * is available yet (e.g. the initial snapshot is still loading). A null
 * backend never connects: syncStatus stays 'idle' and onChange is a no-op.
 * When the backend identity changes — including null-to-backend and
 * backend-to-backend — the previous connection is fully torn down
 * (disconnect + per-connection state reset) before the new one connects.
 * This is the mechanism a future browser-local → daemon in-place migration
 * rides on: swapping the CanvasBackend prop is the whole contract.
 *
 * Drives a LoroDoc from onSnapshot/onRemoteUpdate, hydrates Excalidraw via
 * applyLoroToExcalidraw, and writes scene changes back via a debounced
 * onSceneChange → backend.pushLocalUpdate.
 *
 * Daemon-specific callbacks (onVersionCreated, onRestoreStarted, onRestoreComplete,
 * onHeadChanged, onViewportRequest, onExportRequest) are wired as no-ops to satisfy
 * the CanvasBackendHandlers interface without importing server-only helpers.
 *
 * applyGenerationRef is never reset to 0 — only ever incremented — to avoid
 * stale-async collisions when the hook is reused across canvas remounts.
 *
 * connectionGenerationRef + the per-effect `disposed` flag guard every
 * callback bound to a specific connection: once a connection is torn down
 * (disconnected, or superseded by a backend switch), its callbacks become
 * inert instead of routing pushes/errors to whatever backend is live now.
 */
export function useCanvasSync(backend: CanvasBackend | null): UseCanvasSyncResult {
  const excalidrawAPIRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const docRef = useRef<LoroDoc | null>(null)
  const undoManagerRef = useRef<UndoManager | null>(null)
  const filesCacheRef = useRef<Record<string, BinaryFileData>>({})
  const uploadedFileIdsRef = useRef<Set<string>>(new Set())
  const backendRef = useRef<CanvasBackend | null>(backend)
  backendRef.current = backend

  // Monotonic — never reset to 0 to prevent stale async work from a prior mount
  // landing in the current doc after a fast remount.
  const applyGenerationRef = useRef(0)

  // Monotonic — bumped on every (re)connect (including a switch to null) so
  // a connection's own callbacks can detect they have been superseded.
  const connectionGenerationRef = useRef(0)

  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [apiReady, setApiReady] = useState(false)

  async function applyLoroToExcalidraw(doc: LoroDoc, bk: CanvasBackend) {
    const generation = ++applyGenerationRef.current

    const movable = doc.getMovableList('elements').toJSON()
    const chosenRaw: unknown[] = movable.length > 0 ? movable : doc.getList('elements').toJSON()

    const validated = validateLoroRawElements(chosenRaw)
    const elements = resolveParentedElements(validated) as unknown as ExcalidrawElement[]

    const missingIds = elements
      .filter(
        (el): el is ExcalidrawElement & { fileId: string } =>
          el.type === 'image' &&
          !!(el as { fileId?: string }).fileId &&
          !filesCacheRef.current[(el as { fileId?: string }).fileId!],
      )
      .map((el) => (el as { fileId: string }).fileId)

    await Promise.allSettled(
      missingIds.map(async (fileId) => {
        const blob = await bk.getFile(fileId)
        // A connection swap can resolve this fetch after filesCacheRef has
        // already been reset for the next backend. Re-check the generation
        // right before writing so a stale fetch from a torn-down backend
        // never lands in the new connection's shared file cache.
        if (!blob || generation !== applyGenerationRef.current) return
        const dataURL = await blobToBase64(blob)
        if (generation !== applyGenerationRef.current) return
        filesCacheRef.current[fileId] = {
          id: fileId as FileId,
          mimeType: blob.type as BinaryFileData['mimeType'],
          dataURL: dataURL as DataURL,
          created: Date.now(),
        }
      }),
    )

    if (generation !== applyGenerationRef.current) return

    const api = excalidrawAPIRef.current
    if (!api) return

    api.addFiles(Object.values(filesCacheRef.current))
    const restoredElements = restoreElements(elements, null, { repairBindings: true })
    api.updateScene({
      elements: restoredElements,
      captureUpdate: CaptureUpdateAction.NEVER,
    })
  }

  // Debounced scene change → commit to Loro → pushLocalUpdate via subscribeLocalUpdates.
  // Declared before the connect effect below so that effect can cancel a
  // pending flush on every (re)connect, not only on unmount.
  const onSceneChange = useMemo(() => {
    return debounce((elements: readonly ExcalidrawElement[], files: BinaryFiles) => {
      const doc = docRef.current
      if (!doc) return

      const newEntries = Object.entries(files).filter(
        ([fileId, fd]) => fd && !uploadedFileIdsRef.current.has(fileId),
      ) as [string, BinaryFileData][]

      const bk = backendRef.current

      if (bk && newEntries.length > 0) {
        void bk.putFile(newEntries, (fileId) => uploadedFileIdsRef.current.add(fileId))
      }

      // Write elements into the Loro MovableList using field-by-field set operations,
      // then commit so subscribeLocalUpdates fires and routes bytes to backend.pushLocalUpdate.
      const list = doc.getMovableList('elements')
      const current = list.toJSON() as ExcalidrawElement[]
      const currentIds = new Set(current.map((e: ExcalidrawElement) => e.id))

      // Append newly added elements.
      for (const el of elements) {
        if (!currentIds.has(el.id)) {
          const map = list.insertContainer(list.length, new LoroMap())
          for (const [k, v] of Object.entries(el)) {
            if (v !== undefined) map.set(k, v as Value)
          }
        }
      }

      // Update or tombstone existing elements.
      const nextById = new Map(elements.map((e) => [e.id, e]))
      for (let i = 0; i < list.length; i++) {
        const item = list.get(i)
        if (!(item instanceof LoroMap)) continue
        const id = item.get('id') as string
        const next = nextById.get(id)
        if (!next) {
          item.set('isDeleted', true)
        } else {
          for (const [k, v] of Object.entries(next)) {
            if (v !== undefined) item.set(k, v as Value)
          }
        }
      }

      doc.commit()
    }, 300)
  }, [])

  // Backend connect/disconnect lifecycle. Depends on `backend` identity so a
  // prop swap (including to/from null) tears down the previous connection —
  // via this effect's own cleanup running before the next run's body — and
  // establishes a fresh one instead of connecting once to whatever backend
  // was first passed in.
  useEffect(() => {
    let disposed = false
    const myGeneration = ++connectionGenerationRef.current

    docRef.current = null
    undoManagerRef.current = null
    filesCacheRef.current = {}
    uploadedFileIdsRef.current = new Set()
    applyGenerationRef.current += 1
    onSceneChange.cancel()

    if (backend === null) {
      setSyncStatus('idle')
      return
    }

    const bk = backend

    function isStale(): boolean {
      return disposed || connectionGenerationRef.current !== myGeneration
    }

    bk.connect({
      onConnected() {
        if (isStale()) return
        setSyncStatus('connected')
      },

      onSnapshot(bytes) {
        if (isStale()) return
        // Persisted "snapshot" bytes are whatever pushLocalUpdate's first
        // subscribeLocalUpdates payload happened to be — which is Loro
        // update-format, not doc.export({ mode: 'snapshot' }) format.
        // LoroDoc.fromSnapshot() only accepts true snapshot bytes and throws
        // on update bytes; doc.import() accepts either format, so a fresh
        // doc + import() is the only reconstruction that works for both.
        const doc = new LoroDoc()
        doc.import(bytes)
        docRef.current = doc
        undoManagerRef.current = new UndoManager(doc, { mergeInterval: 500 })

        doc.subscribeLocalUpdates((update) => {
          if (isStale()) return
          void Promise.resolve(bk.pushLocalUpdate(update)).catch(() => {
            if (isStale()) return
            setSyncStatus('error')
          })
        })

        doc.subscribe((e) => {
          if (e.by === 'import' && !isStale()) {
            void applyLoroToExcalidraw(doc, bk)
          }
        })

        void applyLoroToExcalidraw(doc, bk)
      },

      onRemoteUpdate(bytes) {
        if (isStale()) return
        docRef.current?.import(bytes)
      },

      // Daemon-specific callbacks — no-ops in browser-local mode.
      onVersionCreated: () => {},
      onRestoreStarted: () => {},
      onRestoreComplete: () => {},
      onHeadChanged: () => {},
      onViewportRequest: () => {},
      onExportRequest: async () => {},

      onError: () => {
        if (isStale()) return
        setSyncStatus('error')
      },
    })

    return () => {
      disposed = true
      bk.disconnect()
    }
  }, [backend]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reapply the current document once the Excalidraw API becomes ready.
  useEffect(() => {
    const bk = backendRef.current
    if (!apiReady || !docRef.current || !bk) return
    void applyLoroToExcalidraw(docRef.current, bk)
  }, [apiReady]) // eslint-disable-line react-hooks/exhaustive-deps

  const setExcalidrawAPI = useCallback((api: ExcalidrawImperativeAPI) => {
    excalidrawAPIRef.current = api
    setApiReady(true)
  }, [])

  const loroUndo = useCallback(() => {
    const um = undoManagerRef.current
    const doc = docRef.current
    const bk = backendRef.current
    if (!um || !doc || !bk) return false
    if (!um.canUndo()) return false
    um.undo()
    void applyLoroToExcalidraw(doc, bk)
    return true
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const loroRedo = useCallback(() => {
    const um = undoManagerRef.current
    const doc = docRef.current
    const bk = backendRef.current
    if (!um || !doc || !bk) return false
    if (!um.canRedo()) return false
    um.redo()
    void applyLoroToExcalidraw(doc, bk)
    return true
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard and pointer intercept for undo/redo.
  useEffect(() => {
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

    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true } as EventListenerOptions)
      window.removeEventListener('pointerdown', onPointerDown, {
        capture: true,
      } as EventListenerOptions)
    }
  }, [loroUndo, loroRedo])

  // Cancel debounce on unmount to prevent post-unmount Loro writes.
  useEffect(() => {
    return () => {
      onSceneChange.cancel()
    }
  }, [onSceneChange])

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], _appState: AppState, files: BinaryFiles) => {
      onSceneChange(elements, files)
    },
    [onSceneChange],
  )

  return { syncStatus, setExcalidrawAPI, onChange }
}
