import {
  type DocumentContainers,
  deleteSpatialNode,
  documentContainers,
  markThreadPassages,
  type PassageRange,
  readAnnotations,
  readCoreFacets,
  readEdgeLocks,
  readMarkdownBody,
  readNodeLocks,
  readSpatialCanvas,
  readThreadMarks,
  resolveWorkspaceDocumentById,
  type SpatialBatchWriter,
  withSpatialBatch,
  setEdgeLock as workspaceSetEdgeLock,
  setNodeLock as workspaceSetNodeLock,
  writeCanvasComment,
  writeCommentThread,
  writeCoreFacets,
  writeMarkdownBody,
  writeSpatialCanvas,
  writeSpatialEdge,
  writeSpatialNode,
  writeThreadMessage,
} from '@kamiazya/whiteboard-loro-adapter'
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'

/**
 * One identity for "this document has no marks", so a publish that found
 * none does not hand every subscriber a fresh map to diff against.
 */
const NO_THREAD_MARKS: ReadonlyMap<string, PassageRange> = new Map()

/** Why a backend read or write failed. The published contract's own union. */
export type BackendErrorReason = Parameters<NonNullable<DocumentBackendHandlers['onError']>>[0]

import type { CommentThread, SpatialCanvas, StoredCoreFacets } from '@kamiazya/whiteboard-model'
import { LoroDoc, UndoManager } from 'loro-crdt'
import { sameAnnotations, sameThreadMarks } from './annotations-equal.js'
import { getAppLogger } from './app-logger.js'
import { contentStateOf } from './document-state.js'
import {
  type ExportRequestHandlerDeps,
  handleIncomingExportRequest,
} from './document-sync-export.js'
import {
  DOCUMENT_SYNC_CHANGED_EVENT,
  DOCUMENT_SYNC_VERSION_SAVED_EVENT,
  type SyncStatus,
  type UseDocumentSyncOptions,
} from './document-sync-types.js'
import type { EditorCommand, EditorLeafCommand } from './spatial/commands.js'
import { missingThreadMarks } from './text-anchor.js'

const log = getAppLogger('document-sync')

// Upper bound on dispose()'s drain phase (see `dispose()` below). Bounds the
// wait for the flush-triggered commit's pushLocalUpdate invocation so a
// stuck commitChain cannot leave a disconnect() call pending forever.
const DISPOSE_DRAIN_TIMEOUT_MS = 2_000

/** Stable empty set so a lock read before the first snapshot is referentially stable. */
const EMPTY_LOCKS: ReadonlySet<string> = new Set()

/**
 * Stable key identifying the single node/edge a command targets, so a
 * debounce window can dedupe repeat edits to the SAME target down to one
 * write while still keeping edits to DIFFERENT targets separate. Commands
 * with no mapped target (see `writeCommandTarget`'s `default` case) get a
 * fresh key per call — each one already falls back to a full
 * `writeSpatialCanvas` resync, so there is nothing to dedupe.
 */
let unmappedCommandCounter = 0
function commandTargetKey(command: EditorCommand): string {
  switch (command.kind) {
    case 'move-node':
    case 'resize-node':
    case 'set-text':
    case 'delete-node':
      return `node:${command.id}`
    case 'connect-nodes':
      return `edge:${command.edgeId}`
    case 'create-node':
      return `node:${command.node.id}`
    case 'create-comment':
      return `comment:${command.comment.id}`
    case 'set-comment-resolved':
    case 'move-comment':
    case 'set-comment-text':
      return `comment:${command.id}`
    case 'reply-to-thread':
      // Keyed by MESSAGE, not by thread. Every other key here dedupes to the
      // last value for one target, which is right when the target holds one
      // value — a node's position, a comment's text. A reply APPENDS: two
      // replies to the same thread inside one debounce window are two
      // messages, and a `thread:` key would silently commit only the second.
      return `message:${command.message.id}`
    case 'create-thread':
      // Keyed by THREAD, unlike the reply above: what this command carries is
      // the whole conversation, so two of them for the same id inside one
      // window really are one target written twice — while two different
      // threads keep separate keys and both commit.
      return `thread:${command.thread.id}`
    case 'set-body':
      // One key for the whole body: `text` is always the complete document,
      // so a burst of keystrokes inside one debounce window collapses to the
      // last one — which is the entire point of deduping here.
      return 'body'
    case 'set-facets':
      return 'facets'
    case 'batch':
      // Mapped in writeCommandTarget (unlike the default arm), but each
      // batch is one distinct user action — never deduped against another.
      return `batch:${++unmappedCommandCounter}`
    default:
      return `unmapped:${++unmappedCommandCounter}`
  }
}

/**
 * Generation counters shared across every session a single `useDocumentSync`
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
  getOptions: () => UseDocumentSyncOptions
  onStatusChange: (status: SyncStatus) => void
  /**
   * WHY the backend failed, not just that it did.
   *
   * `onStatusChange('error')` is the whole story for a transport that dropped;
   * it is not for a document that is intact and unreadable by THIS build.
   * Collapsing those into one status is how a user with a future-version
   * document gets shown an empty canvas — which says their work is gone when
   * it is sitting on disk.
   */
  onBackendError: (reason: BackendErrorReason) => void
  onRestoreChange: (inProgress: boolean, label: string | null) => void
  dispatchIdentityEvent: (eventName: string, identity: UseDocumentSyncOptions['identity']) => void
  generations: GenerationCounters
  /**
   * When set, the backend's bytes are a WORKSPACE document and this session's
   * content lives on the tree node carrying this documentId: every bridge
   * read/write resolves `documentContainers(doc, contentDocumentId)` instead
   * of the doc's roots. Unset means the doc IS the document (every
   * per-document backend today), which keeps all existing behavior unchanged.
   *
   * Fixed for the session's lifetime, like the backend itself — a different
   * document is a different session. The CRDT plumbing (import/export,
   * UndoManager, subscribeLocalUpdates) stays on the real LoroDoc either way;
   * only WHERE content containers are found changes.
   */
  contentDocumentId?: string
}

export interface DocumentSyncSession {
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
  // Live UndoManager state for button affordances (aria-disabled, tooltip
  // copy). Cheap reads — recompute on every render of the consumer.
  canUndo(): boolean
  canRedo(): boolean
  // Fires whenever the undo stack changes shape (a step pushed on commit, or
  // popped by undo/redo) — the re-render signal button affordances need,
  // since pushes happen on COMMIT, after the canvas publish that triggered
  // the consumer's last render.
  subscribeHistory(listener: () => void): () => void
  // Node lock lives in the doc's sidecar map (crdt's
  // readNodeLocks/setNodeLock): durable and peer-synced, yet never part of
  // the canvas value, so it never reaches an export.
  getNodeLocks(): ReadonlySet<string>
  setNodeLock(nodeId: string, locked: boolean): void
  // Edges lock independently of their endpoints — an edge is its own
  // object, so locking a hub node must not freeze every line touching it.
  getEdgeLocks(): ReadonlySet<string>
  setEdgeLock(edgeId: string, locked: boolean): void
  subscribeLocks(listener: () => void): () => void
  // A markdown document's body lives in the doc's `body` text container, not
  // in the canvas value, so — exactly like locks — it needs its own read and
  // its own notification. Empty string before the first snapshot.
  getMarkdownBody(): string
  subscribeMarkdownBody(listener: () => void): () => void
  /**
   * OKF core facets from the doc's `core` map. `undefined` until hydrated,
   * when none were ever written, and — by `readCoreFacets`' own rule — for
   * any SPATIAL document, which has no frontmatter to hold (ADR-0009
   * decision 3). That last case is why the editor needs no separate flag to
   * decide whether to offer the disclosure.
   */
  getCoreFacets(): StoredCoreFacets | undefined
  /**
   * A stable id for the document's CURRENT state — what a picture drawn from
   * it right now would be a picture OF. `null` before the first snapshot.
   *
   * This is the key every derived rendition of the document is memoised
   * under (ADR-0027): the digest of its content — the same one the workspace
   * listing reports for the row, so a row and this open document name one
   * state one way and share what either drew. A stamp cannot serve: it is
   * one replica's word and a merge does not consult it.
   *
   * It names the DOCUMENT's state, which is deliberately not the instant a
   * canvas is published. `onChange` publishes immediately and writes the
   * document on a debounce (write and commit together), so a key read
   * straight after `onChange` still names the pre-edit document — measured:
   * `getCanvas()` already shows the edit while this does not move. That is
   * not a defect in the key: the key and `exportSnapshot()` are read from the
   * same document and always describe one state. It is why a surface keyed
   * here is driven by the document's change notification, which fires after
   * the write, and not by the React state the editor renders from.
   */
  getContentState(): string | null
  /**
   * The committed document as snapshot bytes, or null before the first
   * snapshot.
   *
   * For handing the document to a worker without decoding it here: measured
   * in a real browser, exporting costs 0.10ms at 12 nodes, 0.10 at 40 and
   * 0.20 at 120, against 0.50 / 0.80 / 1.90ms to read the canvas out on this
   * thread instead. The handover is the cheaper half by 5-9x and barely grows
   * with the document, which is what makes moving the work a release rather
   * than a relocation.
   *
   * Read it in the same synchronous block as `getContentState()` and the two
   * describe the same state: nothing can change the document between two
   * synchronous reads. `exports bytes that decode to the state its key names`
   * pins that, because a refactor making either read async would break the
   * pairing silently — and a picture memoised under the wrong state is the
   * failure the key exists to avoid.
   */
  exportSnapshot(): Uint8Array | null
  // Current published canvas value (empty canvas before the first snapshot).
  getCanvas(): SpatialCanvas
  // Registers a listener for every published canvas value. `origin` tags
  // whether the publish came from this session's own `onChange` ('local') or
  // from initial hydrate / a remote import / undo / redo ('external') — a
  // controlled SpatialEditor needs this to tell apart its own re-render from
  // a replacement mid-gesture. Returns an unsubscribe function.
  subscribe(listener: (canvas: SpatialCanvas, origin: 'local' | 'external') => void): () => void
  /**
   * This document's annotation layer (ADR-0026): its conversations, read
   * from the document-level threads plane rather than picked out of the
   * canvas.
   *
   * Its own channel because it is its own plane. A reply changes no node and
   * no edge, so a subscriber listening only for canvas values would never
   * hear about one — and a markdown document, which publishes no canvas at
   * all, would have no channel to hear about anything.
   */
  getAnnotations(): readonly CommentThread[]
  /**
   * Where each conversation's passage sits in the body right now, by thread
   * id, as the CRDT's own rich-text marks report it.
   *
   * A thread ABSENT from this map is not an error: either its passage was
   * deleted — the orphan signal a stored offset could never give — or the
   * document is one no writer has marked. `resolveTextAnchor` falls back to
   * the quote for both, which is why the quote is still stored.
   */
  getThreadMarks(): ReadonlyMap<string, PassageRange>
  /**
   * Registers a listener for every published annotation-layer value.
   *
   * The marks travel WITH the threads rather than on a channel of their
   * own, so a subscriber can never apply a mark map taken at one instant to
   * a thread list taken at another.
   */
  subscribeAnnotations(
    listener: (threads: readonly CommentThread[], marks: ReadonlyMap<string, PassageRange>) => void,
  ): () => void
}

/**
 * Writes exactly the node/edge the command targets into its own LoroMap
 * entry (via crdt's `writeSpatialNode`/`writeSpatialEdge`, the
 * same field-projection `writeSpatialCanvas` uses), and returns whether it
 * could — false when the command's target id is missing from `next` (see
 * commitToDoc's fallback rule). This is what preserves the node-level CRDT
 * merge granularity a whole-document rewrite would discard: a concurrent
 * peer edit to a different node survives a merge against this write.
 */
function writeCommandTarget(
  host: LoroDoc,
  doc: DocumentContainers,
  next: SpatialCanvas,
  command: EditorCommand,
): boolean {
  switch (command.kind) {
    case 'move-node':
    case 'resize-node':
    case 'set-text': {
      const node = next.nodes.find((n) => n.id === command.id)
      if (!node) return false
      writeSpatialNode(doc, node)
      return true
    }
    case 'connect-nodes': {
      const edge = next.edges.find((e) => e.id === command.edgeId)
      if (!edge) return false
      writeSpatialEdge(doc, edge)
      return true
    }
    case 'create-node': {
      const node = next.nodes.find((n) => n.id === command.node.id)
      if (!node) return false
      writeSpatialNode(doc, node)
      return true
    }
    case 'create-comment':
    case 'set-comment-resolved':
    case 'move-comment':
    case 'set-comment-text': {
      const id = command.kind === 'create-comment' ? command.comment.id : command.id
      const comment = next['x-whiteboard']?.comments?.find((c) => c.id === id)
      if (!comment) return false
      writeCanvasComment(doc, comment)
      return true
    }
    case 'reply-to-thread':
      // Always "handled", like set-body below and for the same reason: the
      // fallback writes the whole SpatialCanvas, and a conversation lives in
      // the threads plane BESIDE it — a full resync would rewrite the canvas
      // and never touch the message. There is no missing-target case to fall
      // back from either: writeThreadMessage is a documented no-op for a
      // thread this replica does not hold, which is deliberate (replying must
      // never be the write that opens a container).
      writeThreadMessage(doc, command.threadId, command.message)
      return true
    case 'create-thread':
      // Always "handled", for `reply-to-thread`'s reason: the fallback writes
      // the whole SpatialCanvas, and a markdown document's canvas holds
      // nothing a new conversation could ride in on. This is the one write
      // allowed to OPEN a thread container (see `writeCommentThread`), which
      // is exactly why replying is not.
      writeCommentThread(doc, command.thread)
      // And where the passage IS, so the CRDT carries it from here on. The
      // thread's quote is what survives the document leaving the CRDT; a
      // mark is what follows an edit — including a concurrent one merged
      // from another peer, which the quote and its offsets can only
      // approximate. Both, because neither replaces the other.
      if (command.thread.anchor.kind === 'text') {
        markThreadPassages(
          host,
          doc,
          new Map([
            [
              command.thread.id,
              { start: command.thread.anchor.start, end: command.thread.anchor.end },
            ],
          ]),
        )
      }
      return true
    case 'set-body':
      // Always "handled", and it MUST be: the fallback below writes the
      // whole SpatialCanvas, which would leave the body container untouched
      // and silently drop the edit.
      writeMarkdownBody(doc, command.text)
      return true
    case 'set-facets':
      // Same must-handle reasoning as set-body: the `core` map is outside
      // the canvas the fallback would rewrite.
      writeCoreFacets(doc, command.facets)
      return true
    case 'delete-node':
      // Always "handled": deleteSpatialNode is a documented no-op for an
      // already-absent id, so there is no missing-target case to fall back
      // from here (unlike the other kinds, which need the target to still
      // exist in `next` to know what to write).
      deleteSpatialNode(doc, command.id)
      return true
    case 'batch': {
      // Pre-validate BEFORE any write: a batch is all-or-nothing at this
      // layer. One unsupported member (or a missing target) sends the WHOLE
      // batch down the full-resync fallback — still exactly one commit and
      // one undo step, just with whole-canvas granularity.
      if (!command.commands.every((sub) => isBatchWritable(sub, next))) return false
      withSpatialBatch(doc, (writer) => {
        for (const sub of command.commands) writeSubCommand(writer, next, sub)
      })
      return true
    }
    default:
      return false
  }
}

/**
 * The leaf kinds a batch can write fine-grained: exactly the operations
 * `SpatialBatchWriter` exposes. `delete-edge` is deliberately included here
 * even though the non-batch path has no case for it (multi-delete needs
 * it); the other kinds fall back to the full resync as a whole batch.
 */
function isBatchWritable(command: EditorLeafCommand, next: SpatialCanvas): boolean {
  switch (command.kind) {
    case 'move-node':
    case 'resize-node':
    case 'set-text':
      return next.nodes.some((n) => n.id === command.id)
    case 'create-node':
      return next.nodes.some((n) => n.id === command.node.id)
    case 'connect-nodes':
      return next.edges.some((e) => e.id === command.edgeId)
    case 'create-edge':
      return next.edges.some((e) => e.id === command.edge.id)
    case 'create-comment':
      return next['x-whiteboard']?.comments?.some((c) => c.id === command.comment.id) ?? false
    case 'set-comment-resolved':
    case 'move-comment':
    case 'set-comment-text':
      return next['x-whiteboard']?.comments?.some((c) => c.id === command.id) ?? false
    case 'delete-node':
    case 'delete-edge':
      // Deletes are no-ops for absent ids — always writable.
      return true
    default:
      return false
  }
}

function writeSubCommand(
  writer: SpatialBatchWriter,
  next: SpatialCanvas,
  command: EditorLeafCommand,
): void {
  switch (command.kind) {
    case 'move-node':
    case 'resize-node':
    case 'set-text': {
      const node = next.nodes.find((n) => n.id === command.id)
      if (node) writer.writeNode(node)
      return
    }
    case 'create-node': {
      const node = next.nodes.find((n) => n.id === command.node.id)
      if (node) writer.writeNode(node)
      return
    }
    case 'connect-nodes': {
      const edge = next.edges.find((e) => e.id === command.edgeId)
      if (edge) writer.writeEdge(edge)
      return
    }
    case 'create-edge': {
      const edge = next.edges.find((e) => e.id === command.edge.id)
      if (edge) writer.writeEdge(edge)
      return
    }
    case 'create-comment':
    case 'set-comment-resolved':
    case 'move-comment':
    case 'set-comment-text': {
      const id = command.kind === 'create-comment' ? command.comment.id : command.id
      const comment = next['x-whiteboard']?.comments?.find((c) => c.id === id)
      if (comment) writer.writeComment(comment)
      return
    }
    case 'delete-node':
      writer.deleteNode(command.id)
      return
    case 'delete-edge':
      writer.deleteEdge(command.id)
      return
    default:
      // Unreachable behind isBatchWritable; a miss here writes nothing and
      // the batch still commits what the other members wrote.
      return
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
function commitToDoc(
  host: LoroDoc,
  doc: DocumentContainers,
  next: SpatialCanvas,
  command: EditorCommand,
): void {
  try {
    if (writeCommandTarget(host, doc, next, command)) return
    log.warn('editor command target missing from next canvas; falling back to full resync', {
      command,
    })
  } catch (err) {
    log.warn('fine-grained Loro write failed; falling back to full resync', err)
  }
  writeSpatialCanvas(doc, next)
}

/**
 * One DocumentSyncSession = one live connection to one DocumentBackend. Owns
 * every piece of state that only makes sense for the lifetime of that single
 * connection (the LoroDoc, its UndoManager, the debounced commit pipeline,
 * queued export requests, published canvas value + subscribers). Constructing
 * a new session for a backend swap therefore resets all of that for free.
 */
export function createDocumentSyncSession(
  backend: DocumentBackend,
  deps: SessionDeps,
): DocumentSyncSession {
  const myGeneration = deps.generations.nextConnectionGeneration()

  let disposed = false
  let doc: LoroDoc | null = null
  let undoManager: UndoManager | null = null
  const historyListeners = new Set<() => void>()
  const lockListeners = new Set<() => void>()
  const bodyListeners = new Set<() => void>()
  // Microtask defer: onPush fires inside Loro's commit, and a listener that
  // synchronously setStates mid-commit would re-enter React from a doc
  // mutation path.
  function notifyHistoryChanged(): void {
    queueMicrotask(() => {
      for (const listener of historyListeners) listener()
    })
  }
  let currentCanvas: SpatialCanvas = { nodes: [], edges: [] }
  let currentAnnotations: readonly CommentThread[] = []
  let currentThreadMarks: ReadonlyMap<string, PassageRange> = NO_THREAD_MARKS
  // Which doc the quote has already been asked about. Compared by identity
  // to the doc itself rather than kept as a boolean: `onSnapshot` mints a
  // fresh LoroDoc for every reconnect, and a boolean would leave the second
  // one un-backfilled forever.
  let backfilledMarksFor: LoroDoc | null = null
  const annotationListeners = new Set<
    (threads: readonly CommentThread[], marks: ReadonlyMap<string, PassageRange>) => void
  >()
  const listeners = new Set<(canvas: SpatialCanvas, origin: 'local' | 'external') => void>()
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

  /**
   * Where this session's content containers live: the doc's roots, or — when
   * a content scope is set — the workspace tree node carrying
   * `contentDocumentId`. Resolved per call, never cached: a restore re-mints
   * the node under a NEW TreeID for the same documentId, and a cached handle
   * would keep pointing at the deleted node.
   */
  /**
   * Where each conversation's passage is now, and — once per body — the
   * marks a document arrived without.
   *
   * Marks do not travel through a markdown file, and a thread an MCP peer
   * wrote never had one, so the quote is asked ONCE at the moment the body
   * is known and its answer written down for the CRDT to carry. Once,
   * because this runs on every external update: re-asking would pay a body
   * search per update for every thread whose passage is genuinely gone, and
   * would keep re-deriving nothing.
   *
   * Guarded, and the read is what matters: a body the backfill cannot write
   * to must still publish the marks it already has, rather than costing the
   * whole annotation channel its value.
   */
  function refreshThreadMarks(
    targetDoc: LoroDoc,
    content: DocumentContainers,
    threads: readonly CommentThread[],
  ): ReadonlyMap<string, PassageRange> {
    let marks: ReadonlyMap<string, PassageRange>
    try {
      marks = readThreadMarks(content)
    } catch (err) {
      log.warn('reading thread marks failed', err)
      return NO_THREAD_MARKS
    }
    if (backfilledMarksFor === targetDoc) return marks
    backfilledMarksFor = targetDoc
    try {
      const missing = missingThreadMarks(readMarkdownBody(content), threads, marks)
      if (missing.size === 0) return marks
      markThreadPassages(targetDoc, content, missing)
      return readThreadMarks(content)
    } catch (err) {
      log.warn('backfilling thread marks failed', err)
      return marks
    }
  }

  function contentOf(targetDoc: LoroDoc): DocumentContainers {
    return deps.contentDocumentId === undefined
      ? targetDoc
      : documentContainers(targetDoc, deps.contentDocumentId)
  }

  function notify(canvas: SpatialCanvas, origin: 'local' | 'external'): void {
    for (const listener of listeners) listener(canvas, origin)
  }

  function notifyAnnotations(threads: readonly CommentThread[]): void {
    for (const listener of annotationListeners) listener(threads, currentThreadMarks)
  }

  function getCanvas(): SpatialCanvas {
    return currentCanvas
  }

  function exportSnapshot(): Uint8Array | null {
    return doc === null ? null : doc.export({ mode: 'snapshot' })
  }

  function getContentState(): string | null {
    return doc === null ? null : contentStateOf(doc)
  }

  function getAnnotations(): readonly CommentThread[] {
    return currentAnnotations
  }

  function getThreadMarks(): ReadonlyMap<string, PassageRange> {
    return currentThreadMarks
  }

  function subscribeAnnotations(
    listener: (threads: readonly CommentThread[], marks: ReadonlyMap<string, PassageRange>) => void,
  ): () => void {
    annotationListeners.add(listener)
    return () => {
      annotationListeners.delete(listener)
    }
  }

  function subscribe(
    listener: (canvas: SpatialCanvas, origin: 'local' | 'external') => void,
  ): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /**
   * Reads the doc and publishes it as the session's current canvas value.
   * The apply-generation counter still guards a session swap racing a
   * publish, but since this path is now fully synchronous (no awaited file
   * fetch in between, unlike the older Excalidraw bridge), the
   * generation check collapses to one bump + one isStale() check right
   * before publishing, rather than a capture-then-recheck pair spanning an
   * await.
   */
  function publishCanvasFromDoc(targetDoc: LoroDoc): void {
    deps.generations.nextApplyGeneration()
    if (isStale()) return
    const content = contentOf(targetDoc)
    const canvas = readSpatialCanvas(content)
    currentCanvas = canvas
    // Read from the same doc read that produced the canvas, so the two
    // published values are always a pair taken at one instant rather than
    // two reads a remote update could land between.
    currentAnnotations = readAnnotations(content)
    currentThreadMarks = refreshThreadMarks(targetDoc, content, currentAnnotations)
    notify(canvas, 'external')
    notifyAnnotations(currentAnnotations)
  }

  /**
   * A local commit reaches the annotation channel too.
   *
   * `publishCanvasFromDoc` runs on an EXTERNAL update, so before this the
   * only way a conversation reached the panel was a remote peer touching the
   * document: a person's own comment was written, drawn on the canvas from
   * the optimistic value, and never listed. Found by dogfooding, not by a
   * test — the remote-reply case was covered and this one was not.
   *
   * Gated on the VALUE having changed rather than on the command kind. A
   * classification over `EditorCommand['kind']` is silent when kind N+1
   * arrives, and what it would fail at is exactly the defect above: a
   * comment-shaped command nobody added to the list, writing a conversation
   * the panel never hears about. Equality here cannot go stale that way.
   */
  function republishAnnotationsIfChanged(targetDoc: LoroDoc): void {
    if (isStale()) return
    let next: readonly CommentThread[]
    try {
      next = readAnnotations(contentOf(targetDoc))
    } catch (err) {
      // Same contract as guardedCommit: the chain must never reject, or every
      // later firing's commit is skipped for the rest of the session.
      log.error('reading annotations after a commit failed', err)
      return
    }
    // The marks are the second half of the same question: a thread whose
    // passage merely MOVED leaves the thread list byte-for-byte identical,
    // so gating on the threads alone would keep drawing the highlight where
    // the text used to be. Both are compared, and neither alone decides.
    const marks = refreshThreadMarks(targetDoc, contentOf(targetDoc), next)
    const movedMarks = !sameThreadMarks(currentThreadMarks, marks)
    currentThreadMarks = marks
    if (!movedMarks && sameAnnotations(currentAnnotations, next)) return
    currentAnnotations = next
    notifyAnnotations(next)
  }

  // Debounce window (ms): edits fired within this window of each other
  // coalesce into a single commit firing.
  const DEBOUNCE_MS = 300

  // Every DISTINCT target (see commandTargetKey) touched since the last
  // commit, keyed so a repeat edit to the SAME target within the window
  // overwrites its own entry (only the latest command per target survives),
  // while edits to DIFFERENT targets accumulate side by side instead of the
  // earlier ones being discarded. `latestNext` is the most recent full
  // SpatialCanvas value across ALL queued commands — safe to reuse for every
  // queued command's write because the SpatialEditor reducer builds `next`
  // cumulatively (each firing's `next` already includes every earlier
  // firing's edit), so the last-seen canvas already carries the correct
  // final state for every target in the queue.
  const pendingTargets = new Map<string, EditorCommand>()
  let latestNext: SpatialCanvas | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  function commitPendingTargets(): void {
    if (!doc || pendingTargets.size === 0 || latestNext === null) {
      pendingTargets.clear()
      latestNext = null
      return
    }
    const targetDoc = doc
    const next = latestNext
    const commands = [...pendingTargets.values()]
    pendingTargets.clear()
    latestNext = null

    // A commit that throws (unexpected shape, Loro internal error) must fail
    // only its own target, not the whole firing or the commit chain — an
    // unguarded throw would reject the chain and silently skip every later
    // firing's commit for the rest of the session.
    const guardedCommit = (): void => {
      for (const command of commands) {
        try {
          // contentOf resolves inside the try: a scoped node deleted between
          // scheduling and commit throws here, and must fail only this
          // target — guardedCommit's contract is that the chain never
          // rejects.
          commitToDoc(targetDoc, contentOf(targetDoc), next, command)
        } catch (err) {
          log.error('scene commit failed; skipping this target', err)
        }
      }
    }
    // Chained with a resolved-only continuation (never `.catch`) because
    // guardedCommit never rejects, so the chain itself never rejects either —
    // or a later firing awaiting it would skip its own commit entirely.
    const previousChain = commitChain
    pendingCommitCount++
    commitChain = previousChain
      .then(guardedCommit)
      .then(() => republishAnnotationsIfChanged(targetDoc))
      .finally(() => {
        pendingCommitCount--
      })
  }

  function onCanvasChange(next: SpatialCanvas, command: EditorCommand): void {
    pendingTargets.set(commandTargetKey(command), command)
    latestNext = next
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      commitPendingTargets()
    }, DEBOUNCE_MS)
  }
  onCanvasChange.flush = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = null
    commitPendingTargets()
  }

  function connect(): void {
    backend.connect({
      onConnected() {
        if (isStale()) return
        deps.onStatusChange('connected')
        backend.sendClientReady()
        // Re-send everything this document holds. A backend whose transport
        // was down dropped the deltas made meanwhile — each push carries only
        // one commit's ops, so no later push replays them — and the server
        // would never learn about those edits. Loro's import is idempotent,
        // so a server that already has them merges a no-op.
        //
        // Full state rather than a delta since the last acknowledged version:
        // nothing acknowledges a push today, so there is no such version to
        // send from, and inventing one that is wrong would lose edits
        // silently again.
        const connectedDoc = doc
        if (connectedDoc !== null) {
          // Same handling as the local-update path: the export and the push
          // both run inside the chain so a synchronous throw cannot escape
          // into the backend's own connect handler, and a rejection is
          // reported rather than left unhandled — this send IS the recovery,
          // so its failure is exactly what the caller needs to hear about.
          void Promise.resolve()
            .then(() => backend.pushLocalUpdate(connectedDoc.export({ mode: 'update' })))
            .catch(() => {
              if (isStale()) return
              deps.onStatusChange('error')
            })
        }
      },

      onDisconnected() {
        if (isStale()) return
        deps.onStatusChange('reconnecting')
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
        // A scoped session's contract with its backend: the workspace bytes
        // hold this document's tree node. Bytes that do not are unreadable
        // FOR THIS DOCUMENT — reported like any other unreadable content,
        // never thrown into the accessors (which would take React down with
        // a doc the session cannot serve anyway).
        if (
          deps.contentDocumentId !== undefined &&
          resolveWorkspaceDocumentById(newDoc, deps.contentDocumentId) === null
        ) {
          deps.onBackendError('corrupt-snapshot')
          deps.onStatusChange('error')
          return
        }
        doc = newDoc
        undoManager = new UndoManager(newDoc, {
          mergeInterval: 500,
          onPush: () => {
            notifyHistoryChanged()
            return { value: null, cursors: [] }
          },
          onPop: () => {
            notifyHistoryChanged()
          },
        })

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
          deps.dispatchIdentityEvent(DOCUMENT_SYNC_CHANGED_EVENT, deps.getOptions().identity)
          // Every change, not just an import: a local UNDO rewrites the body
          // container without one, and the editor holding stale text is the
          // whole failure this notification exists to prevent. Re-notifying
          // the editor that authored the keystroke is harmless — it already
          // holds that value.
          notifyBodyChanged()
          if (e.by === 'import') {
            publishCanvasFromDoc(newDoc)
            // A remote peer may have locked or unlocked something.
            notifyLocksChanged()
          }
        })

        publishCanvasFromDoc(newDoc)
        // Hydration decides the lock set for this session — without this,
        // a persisted lock reads as absent until the next toggle.
        notifyLocksChanged()
        // Same for the stored body: this is the read that makes an
        // agent-authored document open with its prose already in the editor.
        notifyBodyChanged()
      },

      onRemoteUpdate(bytes) {
        if (isStale()) return
        doc?.import(bytes)
      },

      onVersionCreated(payload) {
        if (isStale()) return
        deps.dispatchIdentityEvent(DOCUMENT_SYNC_VERSION_SAVED_EVENT, deps.getOptions().identity)
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
        clearUndo()
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
        try {
          deps.getOptions().onViewportRequest?.(payload)
        } catch (err) {
          log.error('onViewportRequest callback threw', err)
        }
      },

      onAgentActivity(payload) {
        if (isStale()) return
        try {
          deps.getOptions().onAgentActivity?.(payload)
        } catch (err) {
          log.error('onAgentActivity callback threw', err)
        }
      },

      onExportRequest(payload) {
        if (isStale()) return
        handleIncomingExportRequest(payload, { pending: pendingExportRequests })
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

      onError: (reason) => {
        if (isStale()) return
        deps.onBackendError(reason)
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
    notify(next, 'local')
    if (!doc) return
    onCanvasChange(next, command)
  }

  function onEditorReady(): void {
    backend.sendClientReady()
  }

  function clearUndo(): void {
    if (!undoManager) return
    undoManager.clear()
    // clear() empties the stack without an onPop, so notify explicitly —
    // otherwise a consumer keeps rendering an enabled Undo button over an
    // empty stack after a version restore.
    notifyHistoryChanged()
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

  function canUndo(): boolean {
    return (undoManager !== null && doc !== null && undoManager.canUndo()) === true
  }

  function canRedo(): boolean {
    return (undoManager !== null && doc !== null && undoManager.canRedo()) === true
  }

  function subscribeHistory(listener: () => void): () => void {
    historyListeners.add(listener)
    return () => {
      historyListeners.delete(listener)
    }
  }

  function getNodeLocks(): ReadonlySet<string> {
    return doc === null ? EMPTY_LOCKS : readNodeLocks(contentOf(doc))
  }

  function notifyLocksChanged(): void {
    for (const listener of lockListeners) listener()
  }

  function setNodeLock(nodeId: string, locked: boolean): void {
    if (doc === null) return
    // The commit inside setNodeLock reaches peers through the doc's own
    // subscribeLocalUpdates push, like every other local change. The canvas
    // VALUE is unchanged, so subscribers get a lock notification rather
    // than a canvas publish.
    workspaceSetNodeLock(contentOf(doc), nodeId, locked)
    notifyLocksChanged()
  }

  function getEdgeLocks(): ReadonlySet<string> {
    return doc === null ? EMPTY_LOCKS : readEdgeLocks(contentOf(doc))
  }

  function setEdgeLock(edgeId: string, locked: boolean): void {
    if (doc === null) return
    workspaceSetEdgeLock(contentOf(doc), edgeId, locked)
    notifyLocksChanged()
  }

  function getMarkdownBody(): string {
    return doc === null ? '' : readMarkdownBody(contentOf(doc))
  }

  function getCoreFacets(): StoredCoreFacets | undefined {
    return doc === null ? undefined : readCoreFacets(contentOf(doc))
  }

  function notifyBodyChanged(): void {
    for (const listener of bodyListeners) listener()
  }

  function subscribeMarkdownBody(listener: () => void): () => void {
    bodyListeners.add(listener)
    return () => {
      bodyListeners.delete(listener)
    }
  }

  function subscribeLocks(listener: () => void): () => void {
    lockListeners.add(listener)
    return () => {
      lockListeners.delete(listener)
    }
  }

  return {
    connect,
    dispose,
    onChange,
    onEditorReady,
    clearUndo,
    undo,
    redo,
    canUndo,
    canRedo,
    getAnnotations,
    getThreadMarks,
    getCanvas,
    getContentState,
    exportSnapshot,
    subscribeAnnotations,
    subscribe,
    subscribeHistory,
    getNodeLocks,
    setNodeLock,
    getEdgeLocks,
    setEdgeLock,
    subscribeLocks,
    getMarkdownBody,
    subscribeMarkdownBody,
    getCoreFacets,
  }
}
