import {
  CaptureUpdateAction,
  exportToBlob,
  exportToSvg,
  restoreElements,
  serializeAsJSON,
} from '@excalidraw/excalidraw'
import type { ExcalidrawElement, FileId } from '@excalidraw/excalidraw/element/types'
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  DataURL,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'
import type {
  CanvasBackend,
  HeadChangedPayload,
  VersionCreatedPayload,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import {
  exportResponseMessageSchema,
  resolveParentedElements,
  validateLoroRawElements,
} from '@kamiazya/whiteboard-mcp/browser-shared'
import type { Value } from 'loro-crdt'
import { LoroDoc, LoroMap, UndoManager } from 'loro-crdt'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { z } from 'zod'
import { getAppLogger } from '../lib/app-logger.js'
import {
  type ExportRequestHandlerDeps,
  flushPendingExportRequests,
  handleIncomingExportRequest,
} from './canvas-sync-export.js'
import type { DirtyEventDetail } from './useDirtyState.js'

const log = getAppLogger('canvas-sync')

export type SyncStatus = 'idle' | 'connected' | 'error'

// Raster/vector are the only formats the underlying @excalidraw/excalidraw
// export utilities support; there is no PDF export anywhere in the library.
export type SceneExportFormat = 'png' | 'svg' | 'json'

// Daemon-only callback seam. Every member is stored in a ref (see optionsRef
// below) so passing a fresh inline object on every render never forces a
// backend reconnect. A browser-local backend never fires any of these
// events, so none of them are called and the hook behaves exactly as before
// this seam was added.
export interface UseCanvasSyncOptions {
  onVersionCreated?: (payload: VersionCreatedPayload) => void
  onHeadChanged?: (payload: Omit<HeadChangedPayload, 'type'>) => void
  onFileUploadFailed?: () => void
  onFileUploadSucceeded?: () => void
  // Fired in addition to (not instead of) the hook's own syncStatus:'error'
  // transition on a WS auth failure (close 1008), so a daemon-backed page
  // can surface a dedicated banner instead of the generic error state.
  onAuthError?: () => void
  // When set, drives the window-event contract that useDirtyState/HeaderSaveDot
  // listen for: 'excalidraw:doc_changed' on local/remote doc edits and
  // 'excalidraw:version_saved' on a version_created broadcast. Read via
  // optionsRef (never in the connect effect's dep array) so passing a fresh
  // identity object every render never forces a reconnect. Only dispatched
  // when both fields are present — a browser-local caller that never sets
  // this option (or a daemon caller whose identity is still resolving)
  // dispatches nothing, leaving its dirty-state behavior unchanged.
  identity?: { workspaceId: string; slug: string }
}

export interface UseCanvasSyncResult {
  syncStatus: SyncStatus
  setExcalidrawAPI: (api: ExcalidrawImperativeAPI) => void
  onChange: (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => void
  restoreInProgress: boolean
  restoreLabel: string | null
  clearLocalUndo: () => void
  // null when no ExcalidrawImperativeAPI is registered yet (mount race) —
  // callers treat that the same as "export unavailable right now" rather
  // than throwing.
  exportScene: (format: SceneExportFormat) => Promise<Blob | null>
}

// Upper bound on waiting for a file upload before committing anyway. A hung
// putFile would otherwise block the commit chain (and every later scene edit)
// indefinitely; upload failure is non-fatal, so falling through is safe.
const PUT_FILE_TIMEOUT_MS = 15_000

// Dispatches a window event carrying { workspaceId, slug } as detail, but only
// when identity is fully resolved — a partial or absent identity means the
// caller (browser-local, or a daemon page whose identity is still loading)
// never wired the dirty-state contract and must see no events at all.
export function dispatchIdentityEvent(
  eventName: string,
  identity: UseCanvasSyncOptions['identity'],
): void {
  if (typeof window === 'undefined') return
  if (!identity || !identity.workspaceId || !identity.slug) return
  const detail: DirtyEventDetail = { workspaceId: identity.workspaceId, slug: identity.slug }
  window.dispatchEvent(new CustomEvent(eventName, { detail }))
}

// Small debounce helper with no external dependency.
function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  ms: number,
): T & { cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  // Retained as a thunk (rather than the raw args tuple) because TS cannot
  // re-spread a `Parameters<T>` read back out of a variable — it only accepts
  // the tuple at the call site where it is directly bound to `...args`.
  let pending: (() => void) | null = null
  const debounced = (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    pending = () => fn(...args)
    // The trailing edge is just a flush fired by the timer.
    timer = setTimeout(() => debounced.flush(), ms)
  }
  debounced.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
    pending = null
  }
  // Runs the pending call (if any) synchronously right now and clears the
  // timer, instead of waiting for the trailing edge. Used on teardown so a
  // debounced write in flight is persisted rather than cancelled/lost.
  debounced.flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    const run = pending
    pending = null
    run?.()
  }
  return debounced as T & { cancel: () => void; flush: () => void }
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
 * useCanvasSync — canonical sync hook for both the browser-local backend and
 * (once slice 11 wires it up) a daemon-backed connection. Drives a LoroDoc
 * from onSnapshot/onRemoteUpdate, hydrates Excalidraw via
 * applyLoroToExcalidraw, and writes scene changes back via a debounced
 * onSceneChange → backend.pushLocalUpdate.
 *
 * Accepts a CanvasBackend (e.g. BrowserLocalBackend) or null when no backend
 * is available yet (e.g. the initial snapshot is still loading). A null
 * backend never connects: syncStatus stays 'idle' and onChange is a no-op.
 * When the backend identity changes — including null-to-backend and
 * backend-to-backend — the previous connection is fully torn down
 * (disconnect + per-connection state reset) before the new one connects.
 * This is the mechanism a browser-local → daemon in-place migration rides
 * on: swapping the CanvasBackend prop is the whole contract.
 *
 * `options` wires the daemon-only capability receptors (onVersionCreated,
 * onHeadChanged, onFileUploadFailed/Succeeded) plus the restore-overlay
 * state and onViewportRequest/onExportRequest/onAuthError handling that a
 * daemon backend can drive. A browser-local backend never fires any of
 * these events, so passing no `options` behaves exactly as before this seam
 * was added.
 *
 * applyGenerationRef is never reset to 0 — only ever incremented — to avoid
 * stale-async collisions when the hook is reused across canvas remounts.
 *
 * connectionGenerationRef + the per-effect `disposed` flag guard every
 * callback bound to a specific connection: once a connection is torn down
 * (disconnected, or superseded by a backend switch), its callbacks become
 * inert instead of routing pushes/errors/daemon events to whatever backend
 * is live now.
 */
export function useCanvasSync(
  backend: CanvasBackend | null,
  options?: UseCanvasSyncOptions,
): UseCanvasSyncResult {
  const excalidrawAPIRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const docRef = useRef<LoroDoc | null>(null)
  const undoManagerRef = useRef<UndoManager | null>(null)
  const filesCacheRef = useRef<Record<string, BinaryFileData>>({})
  const uploadedFileIdsRef = useRef<Set<string>>(new Set())
  const backendRef = useRef<CanvasBackend | null>(backend)
  backendRef.current = backend

  // Never read inside effect dependency arrays: holds the latest options so a
  // fresh inline object passed on every render never forces a reconnect.
  const optionsRef = useRef<UseCanvasSyncOptions>(options ?? {})
  optionsRef.current = options ?? {}

  const pendingExportRequestsRef = useRef<ExportRequestHandlerDeps['pending']>([])

  // Chains every onSceneChange firing's commit (whether or not it awaits
  // putFile) so firings are applied to the Loro doc strictly in the order
  // they were scheduled, never in the order their async work happens to
  // settle. Without this, a firing with new files stays pending on putFile
  // while a later, file-less firing can commit synchronously first; when the
  // earlier firing's commit finally runs, it writes its own now-stale
  // `elements` snapshot on top, silently reverting/tombstoning the later
  // firing's edits. Reset on every (re)connect so a new connection never
  // waits on a torn-down connection's chain.
  const commitChainRef = useRef<Promise<void>>(Promise.resolve())

  // Monotonic — never reset to 0 to prevent stale async work from a prior mount
  // landing in the current doc after a fast remount.
  const applyGenerationRef = useRef(0)

  // Monotonic — bumped on every (re)connect (including a switch to null) so
  // a connection's own callbacks can detect they have been superseded.
  const connectionGenerationRef = useRef(0)

  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle')
  const [apiReady, setApiReady] = useState(false)
  const [restoreInProgress, setRestoreInProgress] = useState(false)
  const [restoreLabel, setRestoreLabel] = useState<string | null>(null)

  // Bridges flushPendingExportRequests'/handleIncomingExportRequest's
  // string-message `send` contract (ported verbatim from the frozen
  // useWhiteboardSync.helpers.ts) to CanvasBackend's typed
  // sendExportResponse(requestId, data) method. Takes the target backend
  // explicitly (never reads backendRef) so a response is always routed to
  // the connection that produced it, even if the live backend has since
  // been swapped out from under an in-flight export.
  const sendExportResponseMessage = useCallback((bk: CanvasBackend, message: string): void => {
    let parsed: z.infer<typeof exportResponseMessageSchema>
    try {
      parsed = exportResponseMessageSchema.parse(JSON.parse(message))
    } catch {
      return
    }
    bk.sendExportResponse(parsed.requestId, parsed.data)
  }, [])

  // Built fresh at each call site so it reads the live api/pending refs;
  // shared by onExportRequest and the apiReady flush effect. `bk` is always
  // the specific backend the response must reach, not whatever backend is
  // live by the time the export finishes.
  const buildExportDeps = useCallback(
    (bk: CanvasBackend): ExportRequestHandlerDeps => ({
      api: excalidrawAPIRef.current,
      pending: pendingExportRequestsRef.current,
      send: (message) => sendExportResponseMessage(bk, message),
      exportToBlobFn: exportToBlob,
      blobToBase64Fn: blobToBase64,
    }),
    [sendExportResponseMessage],
  )

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
  //
  // `doc`, `bk`, and `connGen` are captured at call time (inside `onChange`,
  // below) rather than read from the mutable refs when the debounce fires.
  // A backend switch mutates backendRef/docRef synchronously, so reading them
  // at fire time can route a change queued against the old connection (both
  // its file uploads and its Loro commit) to the new one. Capturing at call
  // time — and dropping the whole flush if connectionGenerationRef has moved
  // on by the time it fires — keeps a pending change scoped to the
  // connection it was made against.
  const onSceneChange = useMemo(() => {
    return debounce(
      (
        elements: readonly ExcalidrawElement[],
        files: BinaryFiles,
        doc: LoroDoc,
        bk: CanvasBackend,
        connGen: number,
        uploadedFileIds: Set<string>,
      ) => {
        if (connectionGenerationRef.current !== connGen) return

        // Writes the elements into the Loro doc and commits, so
        // subscribeLocalUpdates fires and routes bytes to bk.pushLocalUpdate.
        function commitElements(): void {
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
        }

        const newEntries = Object.entries(files).filter(
          ([fileId, fd]) => fd && !uploadedFileIds.has(fileId),
        ) as [string, BinaryFileData][]

        // Upload completes before the Loro commit (matching the
        // commitAfterUpload ordering contract), but a failed upload is still
        // non-fatal: the elements commit always happens (regardless of a
        // backend switch in the meantime) so nothing is lost locally —
        // `doc`/`bk`/`uploadedFileIds` are captured at call time and isolated
        // to this connection, matching the no-guard subscribeLocalUpdates
        // callback below. `uploadedFileIds` must be the Set instance in effect
        // when this change was queued (not read from the ref at settle time):
        // a backend switch reassigns uploadedFileIdsRef.current to a fresh Set
        // for the new connection, and a stale success settling afterwards must
        // record itself only on its own (now-detached) Set, never bleed into
        // the new connection's set and falsely mark a file as already
        // uploaded there. Only the options.onFileUploadSucceeded/Failed
        // *signal* is generation-guarded, so a superseded connection never
        // misreports its outcome to a consumer that has already moved on to a
        // new backend.
        //
        // Every firing — with or without new files — is chained onto
        // commitChainRef so its commit only runs after the previous firing's
        // commit has fully settled. Without this, a file-less firing (nothing
        // to await) could commit synchronously ahead of an earlier firing
        // still waiting on putFile, and that earlier firing's eventual commit
        // would then overwrite the newer state with its own stale snapshot.
        const previousChain = commitChainRef.current
        // A commit that throws (unexpected element shape, Loro internal error)
        // must fail only its own firing: an unguarded throw would reject the
        // chain and silently skip every later firing's commit for the rest of
        // the session.
        const guardedCommit = (): void => {
          try {
            commitElements()
          } catch (err) {
            log.error('scene commit failed; skipping this firing', err)
          }
        }
        const runThisFiring = async (): Promise<void> => {
          if (newEntries.length === 0) {
            guardedCommit()
            return
          }

          let uploadTimeoutId: ReturnType<typeof setTimeout> | undefined
          try {
            // A hung upload must not block the chain forever — race it against
            // a deadline and fall through to the commit (upload failure is
            // non-fatal; elements persist via the Loro commit either way).
            await Promise.race([
              bk.putFile(newEntries, (fileId) => uploadedFileIds.add(fileId)),
              new Promise((_, reject) => {
                uploadTimeoutId = setTimeout(
                  () => reject(new Error('putFile timed out')),
                  PUT_FILE_TIMEOUT_MS,
                )
              }),
            ])
            if (connectionGenerationRef.current === connGen) {
              try {
                optionsRef.current.onFileUploadSucceeded?.()
              } catch (err) {
                log.error('onFileUploadSucceeded callback threw', err)
              }
            }
          } catch (err) {
            log.error('putFile failed', err)
            if (connectionGenerationRef.current === connGen) {
              try {
                optionsRef.current.onFileUploadFailed?.()
              } catch (callbackErr) {
                log.error('onFileUploadFailed callback threw', callbackErr)
              }
            }
          } finally {
            // Clear the deadline timer when the upload settles first, so a
            // resolved race doesn't leave a live timer behind.
            clearTimeout(uploadTimeoutId)
          }
          guardedCommit()
        }
        // Chained with a resolved-only continuation (never `.catch`) because
        // runThisFiring never rejects — the commit is wrapped in guardedCommit
        // and the upload path in its own try/catch — so the chain itself never
        // rejects either, or a later firing awaiting it would skip its own
        // commit entirely.
        commitChainRef.current = previousChain.then(runThisFiring)
      },
      300,
    )
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
    pendingExportRequestsRef.current = []
    applyGenerationRef.current += 1
    commitChainRef.current = Promise.resolve()
    onSceneChange.cancel()
    // A restore in flight against the connection being torn down (backend
    // switch or disconnect) belongs to that connection alone — leaving these
    // set would permanently stick the restore overlay to a defunct restore
    // even though the new connection (or no connection) is not restoring
    // anything.
    setRestoreInProgress(false)
    setRestoreLabel(null)

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
        bk.sendClientReady()
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
          // No isStale() guard here: this callback is bound to this specific
          // `doc` and the connect-effect's captured `bk`, both fixed for the
          // lifetime of this connection, so it can never route bytes to a
          // different backend. Gating on isStale() would drop a local commit
          // that lands on a microtask AFTER teardown flips `disposed` — which
          // is exactly what happens when onSceneChange.flush() runs during
          // cleanup (doc.commit() fires synchronously, but this subscriber
          // fires on a later microtask, by which point `disposed` is already
          // true) — silently losing the last edit made before a canvas
          // switch or unmount.
          void Promise.resolve(bk.pushLocalUpdate(update)).catch(() => {
            if (isStale()) return
            setSyncStatus('error')
          })
        })

        doc.subscribe((e) => {
          if (isStale()) return
          // Fires for both a local commit (onSceneChange -> doc.commit()) and
          // a remote import (onRemoteUpdate), matching MCP-app parity for
          // what counts as "the doc changed" — but never for the initial
          // snapshot import above, since that happens before this listener
          // is registered.
          dispatchIdentityEvent('excalidraw:doc_changed', optionsRef.current.identity)
          if (e.by === 'import') {
            void applyLoroToExcalidraw(doc, bk)
          }
        })

        void applyLoroToExcalidraw(doc, bk)
      },

      onRemoteUpdate(bytes) {
        if (isStale()) return
        docRef.current?.import(bytes)
      },

      onVersionCreated(payload) {
        if (isStale()) return
        dispatchIdentityEvent('excalidraw:version_saved', optionsRef.current.identity)
        try {
          optionsRef.current.onVersionCreated?.(payload)
        } catch (err) {
          log.error('onVersionCreated callback threw', err)
        }
      },

      onRestoreStarted(payload) {
        if (isStale()) return
        setRestoreInProgress(true)
        setRestoreLabel(payload.label ?? null)
      },

      onRestoreComplete() {
        if (isStale()) return
        setRestoreInProgress(false)
        setRestoreLabel(null)
        undoManagerRef.current?.clear()
      },

      onHeadChanged(payload) {
        if (isStale()) return
        try {
          optionsRef.current.onHeadChanged?.(payload)
        } catch (err) {
          log.error('onHeadChanged callback threw', err)
        }
      },

      onViewportRequest(payload) {
        if (isStale()) return
        const api = excalidrawAPIRef.current
        if (!api) return

        const mode = payload.mode ?? 'fit'
        if (mode === 'fit') {
          const all = api.getSceneElements()
          // If elementIds are provided, fit only those. Otherwise use the full scene.
          const target =
            payload.elementIds !== undefined
              ? all.filter((el) => payload.elementIds!.includes(el.id))
              : all
          // fitToContent also adjusts zoom.
          // Skip empty targets because some implementations mis-handle zoom for empty arrays.
          if (target.length > 0) {
            api.scrollToContent(target, {
              fitToContent: true,
              animate: payload.animate ?? true,
            })
          }
        } else if (mode === 'move') {
          const appState = api.getAppState()
          // updateScene's appState typing is NOT Partial in this Excalidraw
          // version (it demands the full picked shape), so a changed-fields-only
          // object fails to compile — clone the (readonly) snapshot into a
          // mutable copy and overwrite just the requested fields.
          type MutableAppState = {
            -readonly [K in keyof typeof appState]: (typeof appState)[K]
          }
          const merged: MutableAppState = { ...appState }
          if (payload.scrollX !== undefined) merged.scrollX = payload.scrollX
          if (payload.scrollY !== undefined) merged.scrollY = payload.scrollY
          if (payload.zoom !== undefined) {
            merged.zoom = {
              value: payload.zoom as unknown as typeof appState.zoom.value,
            }
          }
          api.updateScene({
            appState: merged,
            captureUpdate: CaptureUpdateAction.NEVER,
          })
        }
      },

      async onExportRequest(payload) {
        if (isStale()) return
        try {
          await handleIncomingExportRequest(payload, buildExportDeps(bk))
        } catch (err) {
          log.error('onExportRequest failed', err)
        }
      },

      onAuthError() {
        if (isStale()) return
        setSyncStatus('error')
        try {
          optionsRef.current.onAuthError?.()
        } catch (err) {
          log.error('onAuthError callback threw', err)
        }
      },

      onError: () => {
        if (isStale()) return
        setSyncStatus('error')
      },
    })

    return () => {
      // Flush any pending debounced scene edit into this connection's doc
      // BEFORE disconnecting, so the last edit made against this backend is
      // persisted instead of dropped by the next effect run's
      // onSceneChange.cancel(). Flushing before `disposed = true` matters:
      // flush() calls doc.commit() synchronously, but its
      // subscribeLocalUpdates callback fires on a later microtask — see the
      // comment on that subscription for why it has no isStale() guard.
      onSceneChange.flush()
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

  // Tell the backend the client is ready (again) once the Excalidraw API
  // mounts, and flush any export request that arrived before it did. Kept
  // independent of the doc-reapply effect above so it still fires when the
  // API becomes ready before the first snapshot lands.
  useEffect(() => {
    if (!apiReady) return
    const bk = backendRef.current
    bk?.sendClientReady()
    if (!bk) return
    void flushPendingExportRequests(buildExportDeps(bk)).catch((err: unknown) => {
      log.error('flushPendingExportRequests failed', err)
    })
  }, [apiReady, buildExportDeps])

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

  // Renders the live scene through the same exportToBlob/exportToSvg utilities
  // Excalidraw's own (harder-to-discover) hamburger-menu export dialog uses,
  // so a header-driven "Export" affordance produces byte-identical output
  // without duplicating export logic.
  const exportScene = useCallback(async (format: SceneExportFormat): Promise<Blob | null> => {
    const api = excalidrawAPIRef.current
    if (!api) return null
    const elements = api.getSceneElements()
    const appState = api.getAppState()
    const files = api.getFiles()
    if (format === 'png') {
      return exportToBlob({ elements, appState, files, exportPadding: 10 })
    }
    if (format === 'json') {
      // serializeAsJSON is the canonical producer of the .excalidraw file
      // format ({type:'excalidraw', version:2, ...}), matching what the
      // daemon's canvas_export_json emits and what Excalidraw's own
      // save-to-file dialog writes.
      const json = serializeAsJSON(elements, appState, files, 'local')
      return new Blob([json], { type: 'application/json' })
    }
    const svg = await exportToSvg({ elements, appState, files, exportPadding: 10 })
    const serialized = new XMLSerializer().serializeToString(svg)
    return new Blob([serialized], { type: 'image/svg+xml' })
  }, [])

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

  const clearLocalUndo = useCallback(() => {
    undoManagerRef.current?.clear()
  }, [])

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

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], _appState: AppState, files: BinaryFiles) => {
      const doc = docRef.current
      const bk = backendRef.current
      if (!doc || !bk) return
      onSceneChange(
        elements,
        files,
        doc,
        bk,
        connectionGenerationRef.current,
        uploadedFileIdsRef.current,
      )
    },
    [onSceneChange],
  )

  return {
    syncStatus,
    setExcalidrawAPI,
    onChange,
    restoreInProgress,
    restoreLabel,
    clearLocalUndo,
    exportScene,
  }
}
