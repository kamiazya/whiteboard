import {
  type CrdtEngine,
  lease,
  type PassageRange,
  type RecordLease,
  randomPeerId,
  type readWorkspaceNodes,
  sharedCrdtEngine,
  type WriteTarget,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  base64ToBytes,
  bytesToBase64,
  type CommentThread,
  type documentEngine,
  type ExtensionFacets,
  type Proposal,
  type SpatialCanvas,
  type StoredCoreFacets,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { getAppLogger } from './app-logger.js'
import type { BodyDocPort } from './body-text-port.js'
import { commitToDoc } from './command-writes.js'
import { SessionBodyText } from './session-body-text.js'
import type { EditorCommand } from './spatial/commands.js'
import { createSubscribers } from './subscribers.js'

const log = getAppLogger('document-sync')

/**
 * Consecutive local edits this close together are one undo step, which is how
 * typing and dragging undo as one.
 */
const UNDO_MERGE_MS = 500

/** Whose change the document announces: this replica's own commit (a write, an undo), or bytes merged in. */
export type ChangedBy = 'local' | 'import'

export interface SessionDocumentOptions {
  /** The keeper's bytes for the record this session serves, snapshot or update format. */
  readonly bytes: Uint8Array
  /** Set when the bytes are a WORKSPACE record and this session's content lives on that document's node. */
  readonly contentDocumentId: string | undefined
  /**
   * Called, before the mutating call returns, with the operations of each
   * local commit, for the keeper. Never for a document that has been closed.
   */
  readonly onLocalUpdate: (update: Uint8Array) => void
  /**
   * Called once per change, in order: for a local commit on the microtask
   * after it, for an import before the call returns, together with any local
   * commit still waiting.
   */
  readonly onChanged: (by: ChangedBy) => void
}

// The engine's reads answer the value the adapter's own readers produce and the
// contract leaves an answer any-value, so each shape below asserts a type and
// parses nothing, deliberately: a parse would strip a field a newer writer added.
const asserted = <T>() => z.custom<T>()
const canvasShape = asserted<{ readonly canvas: SpatialCanvas; readonly skipped: number }>()
const threadsShape = asserted<readonly CommentThread[]>()
const proposalsShape = asserted<readonly Proposal[]>()
const marksShape = asserted<ReadonlyMap<string, PassageRange>>()
const facetsShape = asserted<ExtensionFacets>()
const coreShape = asserted<StoredCoreFacets | undefined>()
const idsShape = z.array(z.string())
const entryShape = z
  .object({ name: z.string().optional(), contentDigest: z.string() })
  .passthrough()
  .nullable()
const nodesShape = asserted<readonly WorkspaceNodeRow[]>()
const stringShape = z.string()
const countShape = z.number()
const nullableShape = z.unknown()

type Entry = z.infer<typeof entryShape>

/** Stable empty answers, so a read of a document that is not held is referentially stable. */
export const NO_LOCKS: ReadonlySet<string> = new Set()
export const NO_FACETS: ExtensionFacets = {}

/**
 * What a document answered the moment its session was disposed, which is all a
 * late reader (a render in flight, an effect cleanup) gets from then on.
 */
interface Kept {
  readonly body: string
  readonly facets: ExtensionFacets
  readonly coreFacets: StoredCoreFacets | undefined
  readonly nodeLocks: ReadonlySet<string>
  readonly edgeLocks: ReadonlySet<string>
  readonly name: string | null | undefined
  readonly listedState: string | null
  readonly snapshot: Uint8Array | null
}

function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** One node of the workspace record, as the adapter's own reader lists it. */
export type WorkspaceNodeRow = ReturnType<typeof readWorkspaceNodes>[number]

/**
 * One engine document a sync session serves: the handle it opened on the
 * realm's engine, the body the editor types into, and every read and write the
 * session makes of the record, scoped to its own document.
 *
 * The only web module that reads the engine synchronously. The editor's
 * getters are called while React renders and inside CodeMirror transactions,
 * where a read cannot be awaited, and the engine of this realm answers at once.
 */
export class SessionDocument implements BodyDocPort {
  readonly body: SessionBodyText
  private readonly engine: CrdtEngine = sharedCrdtEngine()
  private readonly record: RecordLease
  private readonly contentDocumentId: string | undefined
  private readonly options: Pick<SessionDocumentOptions, 'onLocalUpdate' | 'onChanged'>
  private announced: ChangedBy[] = []
  private readonly imported = createSubscribers()
  private closed = false
  private kept: Kept | null = null
  /** Moves on every change, so a read of the whole record is kept until the record changes. */
  private generation = 0
  private entryAt: { readonly generation: number; readonly entry: Entry } | null = null

  constructor(options: SessionDocumentOptions) {
    const { handle } = this.engine.open({
      peer: randomPeerId(),
      bytes: bytesToBase64(options.bytes),
      undoMergeIntervalMs: UNDO_MERGE_MS,
    })
    this.record = lease.ownedLease(this.engine, handle)
    this.contentDocumentId = options.contentDocumentId
    this.options = options
    this.body = new SessionBodyText(
      () => (this.closed ? '' : this.query('markdownBody', stringShape)),
      (runs) => this.spliceBody(runs),
    )
  }

  // ---- reads ----

  private query<T>(query: documentEngine.QueryName, shape: z.ZodType<T>): T {
    if (this.closed) throw new RangeError('this document is closed')
    const args = this.contentDocumentId === undefined ? {} : { documentId: this.contentDocumentId }
    return lease.readNow(this.record, { query, args }, shape)
  }

  /**
   * What a closed document answers: what it held when it was kept at disposal,
   * and the answer of a document that is not held for one that never was
   * (replaced by a snapshot, or refused unread).
   */
  private answer<T>(live: () => T, kept: (held: Kept) => T, none: T): T {
    if (!this.closed) return live()
    return this.kept === null ? none : kept(this.kept)
  }

  /**
   * `read` over the document as it stands including keystrokes the window has
   * not committed. Those are in the mirror and not in the engine, and a state
   * or an export that left them out would describe a body the editor no longer
   * shows. Committing them here would be a second commit inside the window, so
   * they are applied to a throwaway copy instead.
   */
  private readIncludingTyped<T>(read: (from: RecordLease) => T): T {
    if (!this.body.pending) return read(this.record)
    const { handle } = this.engine.fork({ handle: this.record.handle, peer: randomPeerId() })
    const copy = lease.ownedLease(this.engine, handle)
    try {
      this.engine.textSplice({
        handle,
        ...this.hostArgs(),
        text: 'body',
        runs: this.body.peekRuns(),
        judge: 'none',
      })
      return read(copy)
    } finally {
      copy.release()
    }
  }

  private entryOf(from: RecordLease): Entry {
    return lease.readNow(
      from,
      { query: 'workspaceDocumentEntry', args: { documentId: this.contentDocumentId } },
      entryShape,
    )
  }

  /** The record's own entry for the served document; null when a peer removed it. */
  private entry(): Entry {
    if (this.entryAt?.generation === this.generation) return this.entryAt.entry
    const entry = this.entryOf(this.record)
    this.entryAt = { generation: this.generation, entry }
    return entry
  }

  /** False once the document's node is gone from the record; always true for a document that is its own record. */
  hasEntry(): boolean {
    return this.contentDocumentId === undefined || this.entry() !== null
  }

  /** `undefined` with no record entry to read, `null` for an entry with no name. */
  name(): string | null | undefined {
    return this.answer(
      () => {
        if (this.contentDocumentId === undefined) return undefined
        const entry = this.entry()
        return entry === null ? undefined : (entry.name ?? null)
      },
      (held) => held.name,
      undefined,
    )
  }

  /**
   * The state a LISTING names the document by. A scoped session's record holds
   * none of the document's content in its own roots, so it is the node's
   * digest the index compares; null when the node is gone.
   */
  listedContentState(): string | null {
    return this.answer(
      () => {
        if (this.contentDocumentId === undefined) return this.recordContentState()
        if (!this.body.pending) return this.entry()?.contentDigest ?? null
        return this.readIncludingTyped((from) => this.entryOf(from)?.contentDigest ?? null)
      },
      (held) => held.listedState,
      null,
    )
  }

  /** The digest of the whole record, the answer when no node names the document; null once closed. */
  recordContentState(): string | null {
    return this.answer(
      () =>
        this.readIncludingTyped((from) =>
          lease.readNow(from, { query: 'contentDigest' }, stringShape),
        ),
      (held) => held.listedState,
      null,
    )
  }

  canvas(): SpatialCanvas {
    return this.query('spatialCanvas', canvasShape).canvas
  }

  annotations(): readonly CommentThread[] {
    return this.query('annotations', threadsShape)
  }

  proposals(): readonly Proposal[] {
    return this.query('proposals', proposalsShape)
  }

  threadMarks(): ReadonlyMap<string, PassageRange> {
    return this.query('threadMarks', marksShape)
  }

  /** The body including keystrokes the window has not committed. */
  markdownBody(): string {
    return this.answer(
      () => this.body.toString(),
      (held) => held.body,
      '',
    )
  }

  facets(): ExtensionFacets {
    return this.answer(
      () => this.query('facets', facetsShape),
      (held) => held.facets,
      NO_FACETS,
    )
  }

  coreFacets(): StoredCoreFacets | undefined {
    return this.answer(
      () => this.query('coreFacets', coreShape),
      (held) => held.coreFacets,
      undefined,
    )
  }

  nodeLocks(): ReadonlySet<string> {
    return this.answer(
      () => new Set(this.query('nodeLocks', idsShape)),
      (held) => held.nodeLocks,
      NO_LOCKS,
    )
  }

  edgeLocks(): ReadonlySet<string> {
    return this.answer(
      () => new Set(this.query('edgeLocks', idsShape)),
      (held) => held.edgeLocks,
      NO_LOCKS,
    )
  }

  /** Whether the record still holds the plane comments lived in before threads. */
  holdsRetiredCommentPlane(): boolean {
    return this.query('retiredCommentRows', countShape) > 0
  }

  /** Whether the record holds a node, edge, canvas or body in a shape no reader serves. */
  holdsRetiredStoredShape(): boolean {
    return this.query('retiredStoredShape', nullableShape) !== null
  }

  /** What the record lists of its nodes: the rows a document list is drawn from. */
  nodes(): readonly WorkspaceNodeRow[] {
    return lease.readNow(this.record, { query: 'nodes' }, nodesShape)
  }

  /** Called after each import of a peer's bytes that changed the record. */
  subscribeImports(listener: () => void): () => void {
    return this.imported.subscribe(listener)
  }

  /** The body's own subscribers: told after every change, they diff it against what they show. */
  subscribe(listener: () => void): () => void {
    return this.body.subscribe(listener)
  }

  /** Ends the transaction the binding's writes were made in. */
  commit(): void {
    this.commitBody()
  }

  /** The document as snapshot bytes, typed text included; null once closed unkept. */
  exportSnapshot(): Uint8Array | null {
    return this.answer(
      () => this.readIncludingTyped((from) => lease.exportSnapshot(from)),
      (held) => held.snapshot,
      null,
    )
  }

  /** Everything the document holds as an update, which a keeper that missed pushes merges as a no-op. */
  exportUpdate(): Uint8Array {
    return lease.exportUpdateSince(this.record, null)
  }

  // ---- writes ----

  /** One commit for the writes; a refusal or a throw reaches the caller with the document as it was. */
  private apply(writes: readonly documentEngine.Write[]): void {
    if (this.closed) return
    this.body.commit()
    const result = this.engine.write({
      handle: this.record.handle,
      batch: [...writes],
      judge: 'none',
    })
    if (result.outcome !== 'applied') throw new Error('the engine refused a write')
    this.landed(result)
  }

  private hostArgs(): { documentId?: string } {
    return this.contentDocumentId === undefined ? {} : { documentId: this.contentDocumentId }
  }

  /** What the command planner reads and applies, over this document. */
  private target(): WriteTarget {
    return {
      documentId: this.contentDocumentId,
      body: () => this.body.toString(),
      coreFacets: () => this.coreFacets(),
      apply: (writes) => this.apply(writes),
    }
  }

  /** One editor command as one commit, with the whole-canvas fallback `commitToDoc` owns. */
  commitCommand(prev: SpatialCanvas, next: SpatialCanvas, command: EditorCommand): void {
    commitToDoc(this.target(), prev, next, command)
  }

  setNodeLock(id: string, locked: boolean): void {
    this.apply([{ op: 'setNodeLock', args: { id, locked, ...this.hostArgs() } }])
  }

  setEdgeLock(id: string, locked: boolean): void {
    this.apply([{ op: 'setEdgeLock', args: { id, locked, ...this.hostArgs() } }])
  }

  /** Registers where each passage sits, so the CRDT carries it from here on. */
  markThreadPassages(passages: ReadonlyMap<string, PassageRange>): void {
    const pairs = [...passages].map(([id, range]) => [id, { start: range.start, end: range.end }])
    this.apply([{ op: 'markThreadPassages', args: { passages: pairs, ...this.hostArgs() } }])
  }

  /** Sends the keystrokes queued since the last commit as one splice. */
  commitBody(): void {
    this.body.commit()
  }

  private spliceBody(runs: documentEngine.TextRun[]): void {
    if (this.closed) return
    try {
      const result = this.engine.textSplice({
        handle: this.record.handle,
        ...this.hostArgs(),
        text: 'body',
        runs,
        judge: 'none',
      })
      this.landed(result, { bodyMirrorHolds: true })
    } catch (err) {
      // The queued text is not in the document; the mirror follows the document again.
      log.error('committing the typed body text failed', err)
      this.body.invalidate()
      this.body.notify()
    }
  }

  /**
   * Merges a peer's bytes. Keystrokes queued first are committed as the
   * session's own update, so a push carries only what the person typed and the
   * import lands on top of it.
   */
  importBytes(bytes: Uint8Array): void {
    if (this.closed) return
    this.body.commit()
    const before = this.encodedVersion()
    lease.importBytes(this.record, bytes, 'none')
    if (this.encodedVersion() !== before) this.landed(undefined)
  }

  private encodedVersion(): string {
    return this.engine.version({ handle: this.record.handle }).encodedVersion
  }

  // ---- history ----

  canUndo(): boolean {
    return !this.closed && this.engine.undoState({ handle: this.record.handle }).canUndo
  }

  canRedo(): boolean {
    return !this.closed && this.engine.undoState({ handle: this.record.handle }).canRedo
  }

  /** Takes back the last undo step; keystrokes queued before it are committed first, as their own step. */
  undo(): void {
    if (this.closed) return
    this.body.commit()
    this.landed(this.engine.undo({ handle: this.record.handle, judge: 'none' }), {
      immediate: true,
    })
  }

  redo(): void {
    if (this.closed) return
    this.body.commit()
    this.landed(this.engine.redo({ handle: this.record.handle, judge: 'none' }), {
      immediate: true,
    })
  }

  clearUndo(): void {
    if (!this.closed) this.engine.undoClear({ handle: this.record.handle })
  }

  // ---- lifetime ----

  /**
   * Gives the document back; the session never calls this document again.
   * `keepAnswers` is for a disposed session, which a late reader may still ask:
   * it answers what the document held now, and every other closed document
   * answers as one that was never held.
   */
  close({ keepAnswers = false } = {}): void {
    if (this.closed) return
    if (keepAnswers) this.kept = this.keep()
    this.closed = true
    this.record.release()
  }

  private keep(): Kept {
    return {
      body: attempt(() => this.markdownBody(), ''),
      facets: attempt(() => this.facets(), NO_FACETS),
      coreFacets: attempt(() => this.coreFacets(), undefined),
      nodeLocks: attempt(() => this.nodeLocks(), NO_LOCKS),
      edgeLocks: attempt(() => this.edgeLocks(), NO_LOCKS),
      name: attempt(() => this.name(), undefined),
      listedState: attempt(() => this.listedContentState() ?? this.recordContentState(), null),
      snapshot: attempt(() => this.exportSnapshot(), null),
    }
  }

  /**
   * A mutation of the engine's document landed: `result` is the engine's
   * answer for a local commit, and absent for an import (judged by version).
   * `bodyMirrorHolds` is for the commit of the body's own queue, which leaves
   * the editor's mirror exactly the committed text. `immediate` delivers the
   * announcement before the call returns.
   */
  private landed(
    result: documentEngine.MutationResult | undefined,
    { bodyMirrorHolds = false, immediate = false } = {},
  ): void {
    const update = result === undefined ? undefined : localUpdateOf(result)
    if (result !== undefined && update === undefined) return
    this.generation += 1
    if (!bodyMirrorHolds) this.body.invalidate()
    if (update !== undefined) this.options.onLocalUpdate(update)
    this.announce(result === undefined ? 'import' : 'local', result === undefined || immediate)
  }

  /**
   * Queues the announcement of a change. A local commit's is delivered on the
   * next microtask, so the calls that made a burst of commits are all done
   * when the page is told. An import's, an undo's and a redo's are delivered
   * at once and carry every announcement still queued with them, in order,
   * since the editor must show the result by the time those calls return.
   */
  private announce(by: ChangedBy, immediate: boolean): void {
    const first = this.announced.length === 0
    this.announced.push(by)
    if (immediate) this.deliverAnnounced()
    else if (first) queueMicrotask(() => this.deliverAnnounced())
  }

  private deliverAnnounced(): void {
    const changes = this.announced
    this.announced = []
    if (!this.closed) for (const each of changes) this.deliver(each)
  }

  private deliver(by: ChangedBy): void {
    try {
      this.options.onChanged(by)
    } catch (err) {
      log.error('a document change listener threw', err)
    }
    this.body.notify()
    if (by === 'import') this.imported.emit()
  }
}

function localUpdateOf(result: documentEngine.MutationResult): Uint8Array | undefined {
  if (result.outcome !== 'applied' || result.localUpdate === undefined) return undefined
  return base64ToBytes(result.localUpdate) ?? undefined
}
