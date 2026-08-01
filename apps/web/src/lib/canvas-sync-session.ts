import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import type { CanvasBackend } from '@kamiazya/whiteboard-mcp/browser-contract'
import { exportResponseMessageSchema } from '@kamiazya/whiteboard-mcp/browser-shared'
import { LoroDoc, UndoManager } from 'loro-crdt'
import type { z } from 'zod'
import type { EditorCommand } from '../components/spatial-editor/commands.js'
import { getAppLogger } from './app-logger.js'
import {
  type ExportRequestHandlerDeps,
  flushPendingExportRequests,
  handleIncomingExportRequest,
} from './canvas-sync-export.js'
import {
  CANVAS_SYNC_DOC_CHANGED_EVENT,
  CANVAS_SYNC_VERSION_SAVED_EVENT,
  type SyncStatus,
  type UseCanvasSyncOptions,
} from './canvas-sync-types.js'

const log = getAppLogger('canvas-sync')

// canvas-workspace's LoroDoc spatial layout convention (see
// package-canvas-workspace.md): doc.getMap('nodes') / doc.getMap('edges'),
// each a plain-object-valued LoroMap keyed by id. Mirrored here (rather than
// imported — canvas-workspace does not export the key constants) so a
// fine-grained write lands in the exact same container writeSpatialCanvas /
// readSpatialCanvas already agree on.
const NODES_KEY = 'nodes'
const EDGES_KEY = 'edges'

// Upper bound on dispose()'s drain phase (see `dispose()` below). Bounds the
// wait for the flush-triggered commit's pushLocalUpdate invocation so a
// stuck commitChain cannot leave a disconnect() call pending forever.
const DISPOSE_DRAIN_TIMEOUT_MS = 2_000

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

/**
 * Generation counters shared across every session a single `useCanvasSync`
 * hook instance creates over its lifetime (one per backend connect/swap).
 *
 * They live outside any one session — not inside it — because staleness
 * detection must span a session teardown + the next session's construction:
 * a session swap racing a publish must be able to tell it has been
 * superseded, even though the old session never touches the new one's state.
 * Resetting either counter to 0 on every new session would defeat that — a
 * fresh session could collide generation numbers with a still-settling
 * publish from an old one.
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
  // Flushes any pending debounced edit into this session's own doc, then
  // defers closing the transport behind a short drain phase so the
  // flush-triggered commit's pushLocalUpdate call has actually fired before
  // backend.disconnect() runs (bounded — never waits indefinitely).
  dispose(): void
  // `next` is a full SpatialCanvas value (the SpatialEditor's own reducer
  // output, `applyCommand(previous, command)`); `command` names the node/edge
  // the fine-grained Loro write targets. See commitToDoc's doc comment for the
  // fallback rule when the target cannot be located in `next`.
  onChange(next: SpatialCanvas, command: EditorCommand): void
  // Re-sends clientReady and flushes any export request queued before the
  // editor existed. Safe to call before the first snapshot has arrived (doc
  // still null) — sendClientReady and the export flush do not depend on
  // having a doc.
  onEditorReady(): void
  clearUndo(): void
  undo(): boolean
  redo(): boolean
  // Current published canvas value (empty canvas before the first snapshot).
  getCanvas(): SpatialCanvas
  // Registers a listener for every published canvas value (initial hydrate,
  // remote import, undo/redo). Returns an unsubscribe function.
  subscribe(listener: (canvas: SpatialCanvas) => void): () => void
}

function toPlainSpatialValue<T>(value: T): Record<string, unknown> {
  // A round-trip through JSON strips `undefined`-valued keys the same way
  // canvas-workspace's own nodeToFields/edgeToFields do by construction —
  // Loro's LoroMap rejects an `undefined` value, and readSpatialCanvas's
  // per-entry safeParse expects the key to be absent, not `undefined`.
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

/**
 * Writes exactly the node/edge the command targets into its own LoroMap
 * entry, and returns whether it could — false when the command's target id
 * is missing from `next` (see commitToDoc's fallback rule). This is what
 * preserves the node-level CRDT merge granularity a whole-document rewrite
 * would discard: a concurrent peer edit to a different node survives a
 * merge against this write.
 */
function writeCommandTarget(doc: LoroDoc, next: SpatialCanvas, command: EditorCommand): boolean {
  switch (command.kind) {
    case 'move-node':
    case 'resize-node':
    case 'set-text': {
      const node = next.nodes.find((n) => n.id === command.id)
      if (!node) return false
      doc.getMap(NODES_KEY).set(node.id, toPlainSpatialValue(node))
      doc.commit()
      return true
    }
    case 'connect-nodes': {
      const edge = next.edges.find((e) => e.id === command.edgeId)
      if (!edge) return false
      doc.getMap(EDGES_KEY).set(edge.id, toPlainSpatialValue(edge))
      doc.commit()
      return true
    }
    default:
      return false
  }
}

/**
 * Primary path: a fine-grained write of just the command's target node/edge.
 * Fallback: a full `writeSpatialCanvas(doc, next)` resync, used when the
 * command's target id is not present in `next` (an unmapped/unknown command
 * kind, or a target the command set has no delete for), or when the
 * fine-grained write itself throws. Both paths converge on the same `next`
 * canvas — `writeSpatialCanvas` deletes any node/edge id no longer present,
 * so the fallback is also what recovers from a node/edge removed from `next`
 * without a corresponding command.
 */
function commitToDoc(doc: LoroDoc, next: SpatialCanvas, command: EditorCommand): void {
  try {
    if (writeCommandTarget(doc, next, command)) return
    log.warn('editor command target missing from next canvas; falling back to full resync', {
      command,
    })
  } catch (err) {
    log.warn('fine-grained Loro write failed; falling back to full resync', err)
  }
  writeSpatialCanvas(doc, next)
}

/**
 * One CanvasSyncSession = one live connection to one CanvasBackend. Owns
 * every piece of state that only makes sense for the lifetime of that single
 * connection (the LoroDoc, its UndoManager, the debounced commit pipeline,
 * queued export requests, published canvas value + subscribers). Constructing
 * a new session for a backend swap therefore resets all of that for free.
 */
export function createCanvasSyncSession(
  backend: CanvasBackend,
  deps: SessionDeps,
): CanvasSyncSession {
  const myGeneration = deps.generations.nextConnectionGeneration()

  let disposed = false
  let doc: LoroDoc | null = null
  let undoManager: UndoManager | null = null
  let currentCanvas: SpatialCanvas = { nodes: [], edges: [] }
  const listeners = new Set<(canvas: SpatialCanvas) => void>()
  const pendingExportRequests: ExportRequestHandlerDeps['pending'] = []
  // Chains every onChange firing's commit so firings apply to the Loro doc
  // strictly in schedule order, never in async-settle order.
  let commitChain: Promise<void> = Promise.resolve()
  // Counts onChange firings that have been chained onto commitChain but have
  // not yet settled. Lets dispose() tell "nothing was pending, safe to
  // disconnect immediately" apart from "a flush-triggered (or still-running)
  // firing exists" without needing to inspect a Promise's settled state
  // synchronously (not otherwise observable in plain JS).
  let pendingCommitCount = 0

  function isStale(): boolean {
    return disposed || deps.generations.currentConnectionGeneration() !== myGeneration
  }

  function notify(canvas: SpatialCanvas): void {
    for (const listener of listeners) listener(canvas)
  }

  function getCanvas(): SpatialCanvas {
    return currentCanvas
  }

  function subscribe(listener: (canvas: SpatialCanvas) => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /**
   * Reads the doc and publishes it as the session's current canvas value.
   * The apply-generation counter still guards a session swap racing a
   * publish, but since this path is now fully synchronous (no awaited file
   * fetch in between, unlike the pre-OpenCanvas Excalidraw bridge), the
   * generation check collapses to one bump + one isStale() check right
   * before publishing, rather than a capture-then-recheck pair spanning an
   * await.
   */
  function publishCanvasFromDoc(targetDoc: LoroDoc): void {
    deps.generations.nextApplyGeneration()
    if (isStale()) return
    const canvas = readSpatialCanvas(targetDoc)
    currentCanvas = canvas
    notify(canvas)
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
      // lane B (canvas-sync-export.ts) owns replacing ExportRequestHandlerDeps's
      // Excalidraw-shaped `api` entirely; this session has no imperative
      // editor handle to supply, so every export request only ever queues —
      // exportToBlobFn/blobToBase64Fn are consequently unreachable (they are
      // only invoked once `api` is non-null).
      api: null,
      pending: pendingExportRequests,
      send: sendExportResponseMessage,
      exportToBlobFn: () => {
        throw new Error('exportToBlobFn is unreachable while api stays null')
      },
      blobToBase64Fn: () => {
        throw new Error('blobToBase64Fn is unreachable while api stays null')
      },
    }
  }

  // Debounced canvas change -> commit to Loro -> pushLocalUpdate via
  // subscribeLocalUpdates. `doc`/`backend` are fixed for this session's
  // entire lifetime (a session is torn down and replaced wholesale on a
  // backend swap, never mutated in place), so this closure reading them at
  // fire time already keeps a pending change scoped to the connection it was
  // made against. Only the LAST (next, command) pair per debounce window
  // survives — the debounce helper's `pending` thunk already implements that.
  const onCanvasChange = debounce((next: SpatialCanvas, command: EditorCommand) => {
    if (!doc) return
    const targetDoc = doc

    // A commit that throws (unexpected shape, Loro internal error) must fail
    // only its own firing: an unguarded throw would reject the chain and
    // silently skip every later firing's commit for the rest of the session.
    const guardedCommit = (): void => {
      try {
        commitToDoc(targetDoc, next, command)
      } catch (err) {
        log.error('scene commit failed; skipping this firing', err)
      }
    }
    // Chained with a resolved-only continuation (never `.catch`) because
    // guardedCommit never rejects, so the chain itself never rejects either —
    // or a later firing awaiting it would skip its own commit entirely.
    const previousChain = commitChain
    pendingCommitCount++
    commitChain = previousChain.then(guardedCommit).finally(() => {
      pendingCommitCount--
    })
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
          // what happens when onCanvasChange.flush() runs during dispose()
          // (doc.commit() fires synchronously, but this subscriber fires on
          // a later microtask, by which point `disposed` is already true).
          // dispose()'s drain phase is what keeps backend.disconnect() from
          // running before this callback has had a chance to fire — without
          // it, the transport could already be closed by the time this push
          // happens, silently losing the last edit before a canvas switch or
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
          deps.dispatchIdentityEvent(CANVAS_SYNC_DOC_CHANGED_EVENT, deps.getOptions().identity)
          if (e.by === 'import') {
            publishCanvasFromDoc(newDoc)
          }
        })

        publishCanvasFromDoc(newDoc)
      },

      onRemoteUpdate(bytes) {
        if (isStale()) return
        doc?.import(bytes)
      },

      onVersionCreated(payload) {
        if (isStale()) return
        deps.dispatchIdentityEvent(CANVAS_SYNC_VERSION_SAVED_EVENT, deps.getOptions().identity)
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

      onViewportRequest(_payload) {
        if (isStale()) return
        // SpatialEditor owns viewport as local state with no imperative
        // surface exposed to this session. Driving a daemon-requested
        // viewport change is deferred to slice D of the OpenCanvas cutover,
        // which adds a SpatialEditorHandle ref the page can hold and pass
        // through here.
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

  // Waits for the flush-triggered commit (and any commit still queued on
  // commitChain) to have actually invoked backend.pushLocalUpdate, then
  // resolves so dispose() can safely close the transport. Does NOT wait for
  // that pushLocalUpdate call's own promise to settle — only for the call to
  // have happened, since a real transport call already puts bytes on a
  // still-open connection regardless of how long its ack takes, and waiting
  // for an ack could block teardown indefinitely. Bounded by
  // DISPOSE_DRAIN_TIMEOUT_MS so a stuck commitChain cannot leave
  // disconnect() pending forever.
  async function drainBeforePushHasFired(): Promise<void> {
    const chainAtDispose = commitChain
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        // Awaiting the commit chain lets any still-queued firing's
        // doc.commit() run; one more microtask turn after that gives Loro's
        // subscribeLocalUpdates callback (scheduled internally on commit,
        // not synchronously) room to fire and call backend.pushLocalUpdate.
        chainAtDispose.then(() => Promise.resolve()),
        new Promise<void>((resolve) => {
          timeoutId = setTimeout(resolve, DISPOSE_DRAIN_TIMEOUT_MS)
        }),
      ])
    } finally {
      // On the fast path (commit chain wins) the timer would otherwise stay
      // armed for the full DISPOSE_DRAIN_TIMEOUT_MS, delaying real-timer test
      // teardown and holding an event-loop handle needlessly.
      if (timeoutId !== undefined) clearTimeout(timeoutId)
    }
  }

  function dispose(): void {
    // Flush any pending debounced canvas edit into this session's doc BEFORE
    // disconnecting, so the last edit made against this backend is persisted
    // instead of dropped. Flushing before `disposed = true` matters: flush()
    // calls doc.commit() synchronously, but its subscribeLocalUpdates
    // callback fires on a later microtask — see the comment on that
    // subscription for why it has no isStale() guard.
    onCanvasChange.flush()
    disposed = true
    // Bumps the shared apply generation unconditionally, mirroring the
    // connection-generation bump below: without this, a publish this session
    // scheduled (synchronously, so there is no real gap today) could still
    // match a stale generation number reused by a future counter change.
    deps.generations.nextApplyGeneration()
    // dispose() itself stays synchronous (callers do not await it). When the
    // flush above (or an already-in-flight firing) leaves a commit pending,
    // the transport close is deferred behind a short drain phase: without
    // it, that commit's pushLocalUpdate call — fired from Loro's
    // subscribeLocalUpdates on a later microtask, not synchronously with
    // doc.commit() — can still be pending when backend.disconnect() runs,
    // dropping the last edit made just before a canvas switch or unmount.
    // When nothing was pending (no edit was ever made against this session),
    // there is nothing to drain, so disconnect happens immediately —
    // matching every caller that assumes a synchronous teardown.
    if (pendingCommitCount > 0) {
      void drainBeforePushHasFired().then(() => backend.disconnect())
    } else {
      backend.disconnect()
    }
  }

  function onChange(next: SpatialCanvas, command: EditorCommand): void {
    // Published immediately (not debounced) so a controlled SpatialEditor's
    // own re-render reflects the edit right away; only the Loro write is
    // debounced in the background.
    currentCanvas = next
    notify(next)
    if (!doc) return
    onCanvasChange(next, command)
  }

  function onEditorReady(): void {
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
    publishCanvasFromDoc(doc)
    return true
  }

  function redo(): boolean {
    if (!undoManager || !doc) return false
    if (!undoManager.canRedo()) return false
    undoManager.redo()
    publishCanvasFromDoc(doc)
    return true
  }

  return {
    connect,
    dispose,
    onChange,
    onEditorReady,
    clearUndo,
    undo,
    redo,
    getCanvas,
    subscribe,
  }
}
