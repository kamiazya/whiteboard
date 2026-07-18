import { CaptureUpdateAction, exportToBlob, restoreElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement, FileId } from '@excalidraw/excalidraw/element/types'
import type {
  BinaryFileData,
  BinaryFiles,
  DataURL,
  ExcalidrawImperativeAPI,
} from '@excalidraw/excalidraw/types'
import type { CanvasBackend } from '@kamiazya/whiteboard-mcp/browser-contract'
import {
  exportResponseMessageSchema,
  resolveParentedElements,
  validateLoroRawElements,
} from '@kamiazya/whiteboard-mcp/browser-shared'
import type { Value } from 'loro-crdt'
import { LoroDoc, LoroMap, UndoManager } from 'loro-crdt'
import type { z } from 'zod'
import {
  type ExportRequestHandlerDeps,
  flushPendingExportRequests,
  handleIncomingExportRequest,
} from '../hooks/canvas-sync-export.js'
import type { SyncStatus, UseCanvasSyncOptions } from '../hooks/useCanvasSync.js'
import { getAppLogger } from './app-logger.js'

const log = getAppLogger('canvas-sync')

// Upper bound on waiting for a file upload before committing anyway. A hung
// putFile would otherwise block the commit chain (and every later scene edit)
// indefinitely; upload failure is non-fatal, so falling through is safe.
const PUT_FILE_TIMEOUT_MS = 15_000

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
 * Generation counters shared across every session a single `useCanvasSync`
 * hook instance creates over its lifetime (one per backend connect/swap).
 *
 * They live outside any one session — not inside it — because staleness
 * detection must span a session teardown + the next session's construction:
 * an in-flight async op (file fetch, upload settle) started by session N must
 * be able to tell it has been superseded by session N+1, even though N itself
 * never touches N+1's state. Resetting either counter to 0 on every new
 * session would defeat that — a fresh session could collide generation
 * numbers with a still-settling op from an old one.
 */
export interface GenerationCounters {
  nextApplyGeneration(): number
  currentApplyGeneration(): number
  nextConnectionGeneration(): number
  currentConnectionGeneration(): number
}

export function createGenerationCounters(): GenerationCounters {
  let apply = 0
  let connection = 0
  return {
    nextApplyGeneration: () => ++apply,
    currentApplyGeneration: () => apply,
    nextConnectionGeneration: () => ++connection,
    currentConnectionGeneration: () => connection,
  }
}

export interface SessionDeps {
  getExcalidrawAPI: () => ExcalidrawImperativeAPI | null
  // Never cached by the session: called fresh on each use so a caller
  // passing a new inline options object every render is picked up without
  // the session having to be recreated.
  getOptions: () => UseCanvasSyncOptions
  onStatusChange: (status: SyncStatus) => void
  onRestoreChange: (inProgress: boolean, label: string | null) => void
  dispatchIdentityEvent: (eventName: string, identity: UseCanvasSyncOptions['identity']) => void
  generations: GenerationCounters
}

export interface CanvasSyncSession {
  connect(): void
  // Flushes any pending debounced edit into this session's own doc BEFORE
  // disconnecting, so the last edit made against this backend is persisted.
  // Does NOT itself invalidate in-flight upload/getFile signal delivery —
  // only a *new* session's construction (which bumps connectionGeneration)
  // does. A plain dispose (unmount, no successor) leaves a settling
  // putFile/getFile free to still invoke its (latest-options) callback,
  // matching pre-extraction behavior.
  dispose(): void
  onChange(elements: readonly ExcalidrawElement[], files: BinaryFiles): void
  // Reapplies the current doc to Excalidraw, re-sends clientReady, and
  // flushes any export request queued before the API existed. Safe to call
  // before the first snapshot has arrived (doc still null) — sendClientReady
  // and the export flush do not depend on having a doc.
  onApiReady(): void
  clearUndo(): void
  undo(): boolean
  redo(): boolean
}

/**
 * One CanvasSyncSession = one live connection to one CanvasBackend. Owns
 * every piece of state that only makes sense for the lifetime of that single
 * connection (the LoroDoc, its UndoManager, the file cache, the debounced
 * commit pipeline, queued export requests). Constructing a new session for a
 * backend swap therefore resets all of that for free — there is no shared
 * mutable state left to explicitly zero out, unlike the pre-extraction
 * hook's manual per-connection ref-reset block.
 */
export function createCanvasSyncSession(
  backend: CanvasBackend,
  deps: SessionDeps,
): CanvasSyncSession {
  const myGeneration = deps.generations.nextConnectionGeneration()

  let disposed = false
  let doc: LoroDoc | null = null
  let undoManager: UndoManager | null = null
  const filesCache: Record<string, BinaryFileData> = {}
  const uploadedFileIds = new Set<string>()
  const pendingExportRequests: ExportRequestHandlerDeps['pending'] = []
  // Chains every onSceneChange firing's commit (whether or not it awaits
  // putFile) so firings apply to the Loro doc strictly in schedule order,
  // never in async-settle order. Without this, a firing with new files stays
  // pending on putFile while a later, file-less firing commits first; when
  // the earlier firing's commit finally runs, it writes its own now-stale
  // `elements` snapshot on top, silently reverting the later firing's edits.
  let commitChain: Promise<void> = Promise.resolve()

  function isStale(): boolean {
    return disposed || deps.generations.currentConnectionGeneration() !== myGeneration
  }

  // Bridges flushPendingExportRequests'/handleIncomingExportRequest's
  // string-message `send` contract to CanvasBackend's typed
  // sendExportResponse(requestId, data) method.
  function sendExportResponseMessage(message: string): void {
    let parsed: z.infer<typeof exportResponseMessageSchema>
    try {
      parsed = exportResponseMessageSchema.parse(JSON.parse(message))
    } catch {
      return
    }
    backend.sendExportResponse(parsed.requestId, parsed.data)
  }

  function buildExportDeps(): ExportRequestHandlerDeps {
    return {
      api: deps.getExcalidrawAPI(),
      pending: pendingExportRequests,
      send: sendExportResponseMessage,
      exportToBlobFn: exportToBlob,
      blobToBase64Fn: blobToBase64,
    }
  }

  async function applyLoroToExcalidraw(targetDoc: LoroDoc): Promise<void> {
    const generation = deps.generations.nextApplyGeneration()

    const movable = targetDoc.getMovableList('elements').toJSON()
    const chosenRaw: unknown[] =
      movable.length > 0 ? movable : targetDoc.getList('elements').toJSON()

    const validated = validateLoroRawElements(chosenRaw)
    const elements = resolveParentedElements(validated) as unknown as ExcalidrawElement[]

    const missingIds: string[] = []
    for (const el of elements) {
      const fileId = (el as { fileId?: string }).fileId
      if (el.type === 'image' && fileId && !filesCache[fileId]) {
        missingIds.push(fileId)
      }
    }

    await Promise.allSettled(
      missingIds.map(async (fileId) => {
        const blob = await backend.getFile(fileId)
        // A connection swap can resolve this fetch after a NEW session has
        // already started superseding applyGeneration calls. Re-check right
        // before writing so a stale fetch never lands in this (now
        // torn-down) session's file cache instead of silently vanishing.
        if (!blob || generation !== deps.generations.currentApplyGeneration()) return
        const dataURL = await blobToBase64(blob)
        if (generation !== deps.generations.currentApplyGeneration()) return
        filesCache[fileId] = {
          id: fileId as FileId,
          mimeType: blob.type as BinaryFileData['mimeType'],
          dataURL: dataURL as DataURL,
          created: Date.now(),
        }
      }),
    )

    if (generation !== deps.generations.currentApplyGeneration()) return

    const api = deps.getExcalidrawAPI()
    if (!api) return

    api.addFiles(Object.values(filesCache))
    const restoredElements = restoreElements(elements, null, { repairBindings: true })
    api.updateScene({
      elements: restoredElements,
      captureUpdate: CaptureUpdateAction.NEVER,
    })
  }

  // Debounced scene change -> commit to Loro -> pushLocalUpdate via
  // subscribeLocalUpdates. `doc`/`backend`/`uploadedFileIds` are all fixed
  // for this session's entire lifetime (a session is torn down and replaced
  // wholesale on a backend swap, never mutated in place), so this closure
  // reading them at fire time — rather than re-capturing per call — already
  // keeps a pending change scoped to the connection it was made against.
  const onSceneChange = debounce((elements: readonly ExcalidrawElement[], files: BinaryFiles) => {
    if (!doc) return
    const targetDoc = doc

    // Writes the elements into the Loro doc and commits, so
    // subscribeLocalUpdates fires and routes bytes to backend.pushLocalUpdate.
    function commitElements(): void {
      const list = targetDoc.getMovableList('elements')
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

      targetDoc.commit()
    }

    const newEntries = Object.entries(files).filter(
      ([fileId, fd]) => fd && !uploadedFileIds.has(fileId),
    ) as [string, BinaryFileData][]

    // Upload completes before the Loro commit (matching the commitAfterUpload
    // ordering contract), but a failed upload is still non-fatal: the
    // elements commit always happens so nothing is lost locally. Only the
    // getOptions().onFileUploadSucceeded/Failed *signal* is
    // generation-guarded, so a superseded session never misreports its
    // outcome to a consumer that has already moved on to a new backend.
    //
    // Every firing — with or without new files — is chained onto
    // commitChain so its commit only runs after the previous firing's commit
    // has fully settled. Without this, a file-less firing (nothing to await)
    // could commit synchronously ahead of an earlier firing still waiting on
    // putFile, and that earlier firing's eventual commit would then
    // overwrite the newer state with its own stale snapshot.
    const previousChain = commitChain
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
        // A hung upload must not block the chain forever — race it against a
        // deadline and fall through to the commit (upload failure is
        // non-fatal; elements persist via the Loro commit either way).
        await Promise.race([
          backend.putFile(newEntries, (fileId) => uploadedFileIds.add(fileId)),
          new Promise((_, reject) => {
            uploadTimeoutId = setTimeout(
              () => reject(new Error('putFile timed out')),
              PUT_FILE_TIMEOUT_MS,
            )
          }),
        ])
        if (deps.generations.currentConnectionGeneration() === myGeneration) {
          try {
            deps.getOptions().onFileUploadSucceeded?.()
          } catch (err) {
            log.error('onFileUploadSucceeded callback threw', err)
          }
        }
      } catch (err) {
        log.error('putFile failed', err)
        if (deps.generations.currentConnectionGeneration() === myGeneration) {
          try {
            deps.getOptions().onFileUploadFailed?.()
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
    commitChain = previousChain.then(runThisFiring)
  }, 300)

  function connect(): void {
    backend.connect({
      onConnected() {
        if (isStale()) return
        deps.onStatusChange('connected')
        backend.sendClientReady()
      },

      onSnapshot(bytes) {
        if (isStale()) return
        // Persisted "snapshot" bytes are whatever pushLocalUpdate's first
        // subscribeLocalUpdates payload happened to be — which is Loro
        // update-format, not doc.export({ mode: 'snapshot' }) format.
        // LoroDoc.fromSnapshot() only accepts true snapshot bytes and throws
        // on update bytes; doc.import() accepts either format, so a fresh
        // doc + import() is the only reconstruction that works for both.
        const newDoc = new LoroDoc()
        newDoc.import(bytes)
        doc = newDoc
        undoManager = new UndoManager(newDoc, { mergeInterval: 500 })

        newDoc.subscribeLocalUpdates((update) => {
          // No isStale() guard here: this callback is bound to this specific
          // `newDoc` and `backend`, both fixed for the lifetime of this
          // session, so it can never route bytes to a different backend.
          // Gating on isStale() would drop a local commit that lands on a
          // microtask AFTER teardown flips `disposed` — which is exactly
          // what happens when onSceneChange.flush() runs during dispose()
          // (doc.commit() fires synchronously, but this subscriber fires on
          // a later microtask, by which point `disposed` is already true) —
          // silently losing the last edit made before a canvas switch or
          // unmount.
          void Promise.resolve(backend.pushLocalUpdate(update)).catch(() => {
            if (isStale()) return
            deps.onStatusChange('error')
          })
        })

        newDoc.subscribe((e) => {
          if (isStale()) return
          // Fires for both a local commit (onChange -> doc.commit()) and a
          // remote import (onRemoteUpdate), matching MCP-app parity for
          // what counts as "the doc changed" — but never for the initial
          // snapshot import above, since that happens before this listener
          // is registered.
          deps.dispatchIdentityEvent('excalidraw:doc_changed', deps.getOptions().identity)
          if (e.by === 'import') {
            void applyLoroToExcalidraw(newDoc)
          }
        })

        void applyLoroToExcalidraw(newDoc)
      },

      onRemoteUpdate(bytes) {
        if (isStale()) return
        doc?.import(bytes)
      },

      onVersionCreated(payload) {
        if (isStale()) return
        deps.dispatchIdentityEvent('excalidraw:version_saved', deps.getOptions().identity)
        try {
          deps.getOptions().onVersionCreated?.(payload)
        } catch (err) {
          log.error('onVersionCreated callback threw', err)
        }
      },

      onRestoreStarted(payload) {
        if (isStale()) return
        deps.onRestoreChange(true, payload.label ?? null)
      },

      onRestoreComplete() {
        if (isStale()) return
        deps.onRestoreChange(false, null)
        undoManager?.clear()
      },

      onHeadChanged(payload) {
        if (isStale()) return
        try {
          deps.getOptions().onHeadChanged?.(payload)
        } catch (err) {
          log.error('onHeadChanged callback threw', err)
        }
      },

      onViewportRequest(payload) {
        if (isStale()) return
        const api = deps.getExcalidrawAPI()
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
          await handleIncomingExportRequest(payload, buildExportDeps())
        } catch (err) {
          log.error('onExportRequest failed', err)
        }
      },

      onAuthError() {
        if (isStale()) return
        deps.onStatusChange('error')
        try {
          deps.getOptions().onAuthError?.()
        } catch (err) {
          log.error('onAuthError callback threw', err)
        }
      },

      onError: () => {
        if (isStale()) return
        deps.onStatusChange('error')
      },
    })
  }

  function dispose(): void {
    // Flush any pending debounced scene edit into this session's doc BEFORE
    // disconnecting, so the last edit made against this backend is persisted
    // instead of dropped. Flushing before `disposed = true` matters: flush()
    // calls doc.commit() synchronously, but its subscribeLocalUpdates
    // callback fires on a later microtask — see the comment on that
    // subscription for why it has no isStale() guard.
    onSceneChange.flush()
    disposed = true
    backend.disconnect()
  }

  function onChange(elements: readonly ExcalidrawElement[], files: BinaryFiles): void {
    if (!doc) return
    onSceneChange(elements, files)
  }

  function onApiReady(): void {
    if (doc) {
      void applyLoroToExcalidraw(doc)
    }
    backend.sendClientReady()
    void flushPendingExportRequests(buildExportDeps()).catch((err: unknown) => {
      log.error('flushPendingExportRequests failed', err)
    })
  }

  function clearUndo(): void {
    undoManager?.clear()
  }

  function undo(): boolean {
    if (!undoManager || !doc) return false
    if (!undoManager.canUndo()) return false
    undoManager.undo()
    void applyLoroToExcalidraw(doc)
    return true
  }

  function redo(): boolean {
    if (!undoManager || !doc) return false
    if (!undoManager.canRedo()) return false
    undoManager.redo()
    void applyLoroToExcalidraw(doc)
    return true
  }

  return { connect, dispose, onChange, onApiReady, clearUndo, undo, redo }
}
