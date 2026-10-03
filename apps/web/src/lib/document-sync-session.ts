import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  type DocumentContainers,
  documentContainers,
  markThreadPassages,
  type PassageRange,
  readAnnotations,
  readCoreFacets,
  readEdgeLocks,
  readFacets,
  readMarkdownBody,
  readNodeLocks,
  readProposals,
  readSpatialCanvas,
  readThreadMarks,
  resolveWorkspaceDocumentById,
  setEdgeLock as workspaceSetEdgeLock,
  setNodeLock as workspaceSetNodeLock,
} from '@kamiazya/whiteboard-loro-adapter'

/**
 * One identity for "this document has no marks", so a publish that found
 * none does not hand every subscriber a fresh map to diff against.
 */
const NO_THREAD_MARKS: ReadonlyMap<string, PassageRange> = new Map()

/** Why a backend read or write failed. The published contract's own union. */
export type BackendErrorReason = Parameters<NonNullable<DocumentBackendHandlers['onError']>>[0]

import type {
  CommentThread,
  ExtensionFacets,
  Proposal,
  SpatialCanvas,
  StoredCoreFacets,
} from '@kamiazya/whiteboard-model'
import { LoroDoc, UndoManager } from 'loro-crdt'
import { sameAnnotations, sameThreadMarks } from './annotations-equal.js'
import { getAppLogger } from './app-logger.js'
import type { BrowserPersistenceState } from './browser-persistence-state.js'
import { commandTargetKey, commitToDoc } from './command-writes.js'
import { contentStateOf } from './document-state.js'
import {
  DOCUMENT_SYNC_CHANGED_EVENT,
  type SyncStatus,
  type UseDocumentSyncOptions,
} from './document-sync-types.js'
import { PersistenceLedger } from './persistence-ledger.js'
import { type BodyBinding, bodyBindingFor } from './session-body-binding.js'
import type { EditorCommand } from './spatial/commands.js'
import { createSubscribers } from './subscribers.js'
import { missingThreadMarks } from './text-anchor.js'

const log = getAppLogger('document-sync')

// Upper bound on dispose()'s drain phase (see `dispose()` below). Bounds the
// wait for the flush-triggered commit's pushLocalUpdate invocation so a
// stuck commitChain cannot leave a disconnect() call pending forever.
const DISPOSE_DRAIN_TIMEOUT_MS = 2_000

/** Edits within this window (ms) of each other coalesce into one commit. */
export const COMMIT_DEBOUNCE_MS = 300

/** Stable empty set so a lock read before the first snapshot is referentially stable. */
const EMPTY_LOCKS: ReadonlySet<string> = new Set()

/** Stable empty bucket, for the same reason `EMPTY_LOCKS` is stable. */
const EMPTY_FACETS: ExtensionFacets = {}

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
  /**
   * What the session knows about its own writes, as facts for the page to
   * judge: `pending` from the instant an edit is published, `saved` once
   * every write behind it has landed (the store's promise resolved — not the
   * debounce firing, not the commit), `degraded` when the store refused one.
   * Meaningful for a backend whose push answers for durability, which is
   * the browser's; the daemon's push is fire-and-forget over a socket and
   * resolves at once, so a daemon page must not read this as "saved".
   */
  onPersistenceChange?: (state: BrowserPersistenceState) => void
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
  /**
   * The automatic-checkpoint trigger, for a keeper that takes them.
   *
   * A narrow pair rather than the scheduler itself: the session's business is
   * WHEN the document changed and when the page is going away, not what a
   * checkpoint is or where it goes. `signal` is cheap and safe per update
   * (the scheduler debounces); `flush` takes any pending one now.
   *
   * It lives here rather than as the page's own `pagehide` listener because
   * the ORDER against the edit flush is load-bearing and two independent
   * listeners would leave it to registration timing: a checkpoint taken
   * before the edit lands bookmarks the state without it.
   */
  checkpoints?: { readonly signal: () => void; readonly flush: () => void }
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
   * What a CodeMirror binding writes the body through: the live doc, the
   * body text on it, and the session's debounced commit. Null before the
   * first snapshot. One object per doc — a new one only when a snapshot
   * replaces the doc — so an editor keyed on it remounts exactly then.
   */
  getBodyBinding(): BodyBinding | null
  /**
   * OKF core facets from the doc's `core` map. `undefined` until hydrated,
   * when none were ever written, and — by `readCoreFacets`' own rule — for
   * any SPATIAL document, which has no frontmatter to hold (ADR-0009
   * decision 3). That last case is why the editor needs no separate flag to
   * decide whether to offer the disclosure.
   */
  getCoreFacets(): StoredCoreFacets | undefined
  /**
   * The document's EXTENSION facets (`{namespace}.{name}/v{n}`), from the
   * doc's `facets` map. Empty until hydrated and for a document that
   * declares none.
   *
   * Published on the same signal as `getCoreFacets`, and here for the same
   * reason: what a markdown document wears — its `visual.symbol/v0` mark —
   * is no canvas value, so a page reading only the canvas cannot see it.
   * The spatial half of that mark rides the canvas envelope instead, which
   * is why only one kind reads this.
   */
  getFacets(): ExtensionFacets
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
  /** This document's proposals (ADR-0029), read from the same doc read as the canvas. */
  getProposals(): readonly Proposal[]
  /** Fires whenever the proposal layer changes — a new one, or a decision on one. */
  subscribeProposals(listener: (proposals: readonly Proposal[]) => void): () => void
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
  const historyChanged = createSubscribers()
  const locksChanged = createSubscribers()
  const bodyChanged = createSubscribers()
  // Microtask defer: onPush fires inside Loro's commit, and a listener that
  // synchronously setStates mid-commit would re-enter React from a doc
  // mutation path.
  function notifyHistoryChanged(): void {
    queueMicrotask(() => {
      historyChanged.emit()
    })
  }
  let currentCanvas: SpatialCanvas = { nodes: [], edges: [] }
  let currentAnnotations: readonly CommentThread[] = []
  let currentProposals: readonly Proposal[] = []
  let currentThreadMarks: ReadonlyMap<string, PassageRange> = NO_THREAD_MARKS
  // Which doc the quote has already been asked about. Compared by identity
  // to the doc itself rather than kept as a boolean: `onSnapshot` mints a
  // fresh LoroDoc for every reconnect, and a boolean would leave the second
  // one un-backfilled forever.
  let backfilledMarksFor: LoroDoc | null = null
  const annotationsChanged =
    createSubscribers<[readonly CommentThread[], ReadonlyMap<string, PassageRange>]>()
  const proposalsChanged = createSubscribers<[readonly Proposal[]]>()
  const canvasChanged = createSubscribers<[SpatialCanvas, 'local' | 'external']>()
  // Chains every onChange firing's commit so firings apply to the Loro doc
  // strictly in schedule order, never in async-settle order.
  let commitChain: Promise<void> = Promise.resolve()
  // Counts onChange firings that have been chained onto commitChain but have
  // not yet settled. Lets dispose() tell "nothing was pending, safe to
  // disconnect immediately" apart from "a flush-triggered (or still-running)
  // firing exists" without needing to inspect a Promise's settled state
  // synchronously (not otherwise observable in plain JS).
  let pendingCommitCount = 0

  const persistence = new PersistenceLedger(
    (state) => deps.onPersistenceChange?.(state),
    () => debounceTimer !== null || pendingTargets.size > 0 || pendingCommitCount > 0,
  )
  // Loro delivers subscribeLocalUpdates on a later microtask than the commit
  // (see the subscription below), so "the commit drained" is not yet "the
  // push was issued". Two turns are what drainBeforePushHasFired gives it
  // too; only then can a quiet session honestly be called saved.
  async function settleAfterCommitDrained(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    persistence.settle()
  }

  function isStale(): boolean {
    return disposed || deps.generations.currentConnectionGeneration() !== myGeneration
  }

  /**
   * One push the ledger counts: its landing settles, its refusal fails. The
   * bytes are taken inside the chain, so a synchronous throw cannot escape
   * into the backend's own handler.
   */
  function send(bytes: () => Uint8Array): void {
    const push = persistence.pushStarted()
    void Promise.resolve()
      .then(() => backend.pushLocalUpdate(bytes()))
      .then(push.resolved, () => {
        if (isStale()) return push.dropped()
        deps.onStatusChange('error')
        push.rejected()
      })
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
    canvasChanged.emit(canvas, origin)
  }

  function notifyAnnotations(threads: readonly CommentThread[]): void {
    annotationsChanged.emit(threads, currentThreadMarks)
  }

  /**
   * The proposal layer's own channel (ADR-0029), beside the annotation one
   * rather than folded into it: they are two layers above content, and a
   * channel named for one while carrying the other is how a name stops
   * meaning anything.
   *
   * Published from the same functions and in the same synchronous turn as
   * the canvas, which is what a reader needs — `canvasChangeConflicts`
   * compares a proposal's prior against the canvas, so the two must be read
   * from ONE doc read or a conflict is judged against a board that has
   * already moved.
   */
  function notifyProposals(proposals: readonly Proposal[]): void {
    proposalsChanged.emit(proposals)
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

  function getProposals(): readonly Proposal[] {
    return currentProposals
  }

  function subscribeProposals(listener: (proposals: readonly Proposal[]) => void): () => void {
    return proposalsChanged.subscribe(listener)
  }

  function getThreadMarks(): ReadonlyMap<string, PassageRange> {
    return currentThreadMarks
  }

  function subscribeAnnotations(
    listener: (threads: readonly CommentThread[], marks: ReadonlyMap<string, PassageRange>) => void,
  ): () => void {
    return annotationsChanged.subscribe(listener)
  }

  function subscribe(
    listener: (canvas: SpatialCanvas, origin: 'local' | 'external') => void,
  ): () => void {
    return canvasChanged.subscribe(listener)
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
    currentProposals = readProposals(content)
    notify(canvas, 'external')
    notifyAnnotations(currentAnnotations)
    notifyProposals(currentProposals)
  }

  /**
   * A local commit reaches the annotation channel too.
   *
   * `publishCanvasFromDoc` runs on an EXTERNAL update, so before this the
   * only way a conversation reached the panel was a remote peer touching the
   * document: a person's own comment was written, drawn on the canvas from
   * the optimistic value, and never listed — the remote-reply case was
   * covered and this one was not.
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
    // The proposal layer changes on the same signal and is compared the
    // same cheap way: adopting one rewrites its status, and a person's edit
    // can turn a change into a conflict without touching the proposal at
    // all — which the canvas publish beside this already reports.
    const nextProposals = readProposals(contentOf(targetDoc))
    if (JSON.stringify(currentProposals) !== JSON.stringify(nextProposals)) {
      currentProposals = nextProposals
      notifyProposals(nextProposals)
    }
    if (!movedMarks && sameAnnotations(currentAnnotations, next)) return
    currentAnnotations = next
    notifyAnnotations(next)
  }

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
  // The canvas the editor held at the window's FIRST edit: what a whole-canvas
  // reconcile may delete against. Never re-read from the doc at commit time —
  // a peer record merged inside the window would then count as visible to
  // this edit and be deleted by it.
  let windowStart: SpatialCanvas | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  // Body text the editor binding wrote at its positions and has not
  // committed: the ops are in the doc (a read sees them) and ride the same
  // debounce as a canvas edit, so a burst of keystrokes is one commit and
  // one push.
  let bodyOpsPending = false

  function commitPendingTargets(): void {
    const commitBody = bodyOpsPending
    bodyOpsPending = false
    const hasTargets = pendingTargets.size > 0 && latestNext !== null
    if (!doc || (!hasTargets && !commitBody)) {
      pendingTargets.clear()
      latestNext = null
      return
    }
    const targetDoc = doc
    const next = latestNext
    const prev = windowStart
    const commands = next === null ? [] : [...pendingTargets.values()]
    pendingTargets.clear()
    latestNext = null

    // A commit that throws (unexpected shape, Loro internal error) must fail
    // only its own target, not the whole firing or the commit chain — an
    // unguarded throw would reject the chain and silently skip every later
    // firing's commit for the rest of the session.
    const guardedCommit = (): void => {
      if (commitBody) targetDoc.commit()
      for (const command of commands) {
        try {
          // contentOf resolves inside the try: a scoped node deleted between
          // scheduling and commit throws here, and must fail only this
          // target — guardedCommit's contract is that the chain never
          // rejects.
          if (next !== null)
            commitToDoc(targetDoc, contentOf(targetDoc), prev ?? next, next, command)
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
        void settleAfterCommitDrained()
      })
  }

  function armDebounce(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      commitPendingTargets()
    }, COMMIT_DEBOUNCE_MS)
  }

  function onCanvasChange(next: SpatialCanvas, command: EditorCommand): void {
    persistence.edited()
    pendingTargets.set(commandTargetKey(command), command)
    latestNext = next
    armDebounce()
  }

  /**
   * The binding wrote body ops into `bound`. A doc a snapshot has replaced is
   * not ours to commit — the editor remounts on the new binding instead.
   */
  function bodyEdited(bound: LoroDoc): void {
    if (bound !== doc) return
    persistence.edited()
    bodyOpsPending = true
    armDebounce()
  }

  const bodyBindingOf = bodyBindingFor({
    contentOf,
    onEdited: bodyEdited,
    isCurrent: (target) => target === doc,
  })
  function getBodyBinding(): BodyBinding | null {
    return bodyBindingOf(doc)
  }
  onCanvasChange.flush = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = null
    commitPendingTargets()
  }

  // The window holds edits that are already on screen, and a tab that goes
  // away inside it loses them. `pagehide` and `visibilitychange` → hidden are
  // the last signals a page reliably gets (Page Lifecycle API; `beforeunload`
  // is not delivered on mobile and `unload` is unreliable everywhere), so the
  // write goes out on them. Becoming visible again is the same event name
  // and must NOT flush — that would write mid-gesture on every tab switch.
  //
  // What this covers, measured in Chromium with the tab's scripts frozen
  // after the signal so the debounce could not be what landed it: a tab that
  // is HIDDEN (switched away, backgrounded) keeps running, and the write
  // reaches IndexedDB within 50ms. A tab CLOSED or reloaded inside the window
  // is torn down before the asynchronous chain behind the flush reaches the
  // store, and the edit is still lost — the same as without this listener.
  // Closing that last gap means not having a window at all (write at once,
  // commit later), not a better signal.
  // The edit flush first in both, then the checkpoint: the edit is what the
  // checkpoint would be bookmarking.
  function onVisibilityChange(): void {
    if (document.visibilityState !== 'hidden') return
    onCanvasChange.flush()
    deps.checkpoints?.flush()
  }
  function onPageHide(): void {
    onCanvasChange.flush()
    deps.checkpoints?.flush()
  }
  function listenForPageLeaving(): void {
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
  }
  function stopListeningForPageLeaving(): void {
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', onPageHide)
  }

  function connect(): void {
    listenForPageLeaving()
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
        // silently again. Counted like any push: its landing is when the
        // writes lost during the outage land, so it settles their failure.
        const connectedDoc = doc
        if (connectedDoc !== null) send(() => connectedDoc.export({ mode: 'update' }))
      },

      onWritesLanded() {
        if (isStale()) return
        deps.onStatusChange('connected')
        persistence.landed()
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
          // "This document just changed locally" — the browser's analogue of
          // the update the daemon's trigger rides. Before the push rather
          // than after it: the scheduler only arms a timer here, and a
          // checkpoint that waited for durability would miss the edits a
          // failing store is exactly when you want bookmarked.
          deps.checkpoints?.signal()
          send(() => update)
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
        // A write failure that is not a rejected push arrives here — the
        // browser backend's store, or a worker-backed transport's keeper (see
        // persistence-ledger). The ledger tells it apart from a failed LOAD.
        if (reason === 'storage-failure') persistence.storageFailed()
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
    stopListeningForPageLeaving()
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
    if (latestNext === null) windowStart = currentCanvas
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

  /**
   * Takes back a write still inside its debounce window, answering whether
   * there was one.
   *
   * A queued write carries a WHOLE canvas (`latestNext`) captured before the
   * undo, so the moment the document moves underneath it, committing it
   * writes the pre-undo picture back. A commit publishes nothing, so the
   * screen keeps showing the undone state over a document that no longer
   * holds it — and the write is a local change, which discards the redo
   * stack on its way past. Measured at the page layer: the node was gone
   * from the editor and back in the document 250ms later, with Redo
   * disabled and nothing to restore.
   *
   * Dropped rather than flushed: a flush would have to drain the commit
   * chain before the undo could pop the step it creates, and `undo` answers
   * a click synchronously.
   * ponytail: drop the queued write; flush it instead if undo ever becomes
   * something a caller can await.
   */
  function dropQueuedWrite(): boolean {
    if (debounceTimer === null && pendingTargets.size === 0) return false
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = null
    pendingTargets.clear()
    latestNext = null
    // Nothing is left to land, and `unsaved` is only cleared by something
    // settling — without this the document reads as pending for the rest of
    // the session.
    void settleAfterCommitDrained()
    return true
  }

  function undo(): boolean {
    if (!doc) return false
    // An edit still inside its debounce window is the most recent thing the
    // person did and is not in the document yet, so taking it back IS the
    // undo — the committed stack is left alone.
    if (dropQueuedWrite()) {
      publishCanvasFromDoc(doc)
      return true
    }
    if (!undoManager?.canUndo()) return false
    undoManager.undo()
    publishCanvasFromDoc(doc)
    return true
  }

  function redo(): boolean {
    if (!undoManager || !doc) return false
    if (!undoManager.canRedo()) return false
    // Same staleness, for the same reason: the queued write was computed
    // against the document as it stood before this redo.
    dropQueuedWrite()
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
    return historyChanged.subscribe(listener)
  }

  function getNodeLocks(): ReadonlySet<string> {
    return doc === null ? EMPTY_LOCKS : readNodeLocks(contentOf(doc))
  }

  function notifyLocksChanged(): void {
    locksChanged.emit()
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

  function getFacets(): ExtensionFacets {
    return doc === null ? EMPTY_FACETS : readFacets(contentOf(doc))
  }

  function notifyBodyChanged(): void {
    bodyChanged.emit()
  }

  function subscribeMarkdownBody(listener: () => void): () => void {
    return bodyChanged.subscribe(listener)
  }

  function subscribeLocks(listener: () => void): () => void {
    return locksChanged.subscribe(listener)
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
    getProposals,
    getThreadMarks,
    getCanvas,
    getContentState,
    exportSnapshot,
    subscribeAnnotations,
    subscribeProposals,
    subscribe,
    subscribeHistory,
    getNodeLocks,
    setNodeLock,
    getEdgeLocks,
    setEdgeLock,
    subscribeLocks,
    getMarkdownBody,
    subscribeMarkdownBody,
    getBodyBinding,
    getCoreFacets,
    getFacets,
  }
}
