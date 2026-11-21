import { compactionCut } from '@kamiazya/whiteboard-history'
import {
  bindRecordOps,
  legacyRecordOps,
  projectWorkspaceDocument,
  type RecordSession,
  resolveWorkspaceDocument,
} from '@kamiazya/whiteboard-loro-adapter'
import { messageOf } from '@kamiazya/whiteboard-model'
import { isDatabaseBusy } from '@kamiazya/whiteboard-ports'
import {
  type CaughtUp,
  DocumentStoreWorkspaceDocs,
  type WorkspaceDocCursor,
  type WorkspaceDocs,
} from '@kamiazya/whiteboard-workspace-index'
import { type Frontiers, LoroDoc, type PeerID, VersionVector } from 'loro-crdt'
import { getLogger } from '../log.js'
import { validateDocumentPath, validateWorkspaceId } from '../validators.js'
import { corruptStoredData, isCorruptStoredDataError } from './corrupt-stored-data.js'
import { upsertWorkspaceRow } from './db/upsert-workspace.js'
import { LibsqlDocumentStore } from './libsql/libsql-document-store.js'
import { RecordCache } from './record-cache.js'
import { documentStoreReady } from './store-handles.js'
import { globalStoreScope, type StoreScope } from './store-scope.js'
import { withWorkspaceWriteLock, workspaceWriteLockInUse } from './workspace-lock.js'

/**
 * The live WORKSPACE documents this process serves and writes through, one
 * per workspace. This is the daemon's twin of the browser backend holding
 * its workspace doc across a session: `DocumentStoreWorkspaceDocs.open`
 * reads the whole stored record, so opening per save would cost
 * O(workspace) on every keystroke burst, while the incremental `save`
 * exports only what moved.
 *
 * Keyed by data dir AS WELL as workspace id, because the cache is process-wide
 * while a store is not: two stores over different directories (a second
 * keeper's, or a test's fresh one) must not be served each other's document
 * tree for the same workspace id.
 *
 * Coherence rule: every content write THIS process makes flows through the
 * cached instance (saveDocument diffs the caller's doc against it), so what
 * can leave it stale is a writer that is not this process. Two kinds exist: a
 * path here that writes the stored record directly — the tree index used by
 * delete/rename does — which drops the entry so the next operation reopens the
 * merged state; and ANOTHER PROCESS over the same data directory (the stdio
 * entry beside the daemon), which a cache hit cannot see. Every access
 * therefore asks the store whether the record holds ops this document lacks
 * (`followRecord`) before it serves the document.
 */

// What giving a `LoroDoc` back does: nothing, since collecting it frees it. A test
// that wants to see the loans of a record end watches this instead.
let releasedForTests: LoroDoc[] | null = null

/** Test-only: how many loans of a record are out right now. */
export function _workspaceRecordLoansForTests(): number {
  return records.outstanding
}

/** Test-only: the records the cache has given back since this was first asked for. */
export function _workspaceRecordReleasesForTests(): LoroDoc[] {
  releasedForTests ??= []
  return releasedForTests
}

/**
 * How many workspace records stay resident, least recently used dropped first.
 *
 * Without a bound every record the process ever opened stayed for its
 * lifetime — the daily file-GC sweep opens every workspace it keeps — and in
 * server mode one process serves every tenant over one WASM heap.
 * `scripts/measure/workspace-record-memory.mjs` puts a live record at 8.5MB
 * for 90 documents and 64.5MB for 360 (super-linear in document count), so 16
 * holds about 136MB of typical workspaces and about 1GiB of 360-document ones,
 * well inside a wasm32 heap with room left for an export's amplification.
 * A miss costs one read of the stored record, which is what a restart costs.
 *
 * Dropping a record is safe because this module already serves a writer it
 * cannot see: another process over the same data dir. A caller still holding
 * a dropped instance saves through `DocumentStoreWorkspaceDocs.save`, which
 * appends only what the stored frontier lacks, and the reopened instance
 * catches up from the record on its next access (`followRecord`). What would
 * NOT be safe is dropping ops that were never saved, and every writer mutates
 * the record under the workspace write lock, so a record whose lock is held
 * or awaited is never chosen; the cache runs over the bound instead until it
 * is released, and the next access, hit or miss, trims it back.
 *
 * Dropping a record also drops what it was following: no `followRecord` runs
 * for it until it is reopened, so a write another process makes meanwhile is
 * seen by nobody here. The subscribers were told only what the old instance
 * held, while a reopened instance already level with the record gives
 * `followRecord` nothing to announce — so `openFollowed` keeps the version a
 * record was dropped at
 * (`droppedVersions`) and its gain is announced on reopen.
 * `followedTo` is keyed by the instance and leaves with it.
 *
 * ponytail: a bound by count, not bytes. A byte-weighted bound needs a size
 * this module does not have on a hit without an export, which is O(record).
 */
export const WORKSPACE_DOC_CACHE_MAX_ENTRIES = 16

/**
 * The encoded version each record was dropped at by the bound, so a reopen
 * can announce what arrived while nothing here followed it. Only the bound
 * records one: an explicit eviction drops a record that may hold ops storage
 * refused, and a version taken from it would announce nothing that is true.
 *
 * ponytail: bounded by count, oldest forgotten first; a workspace forgotten
 * here and written by another process before its reopen reaches its
 * subscribers when they next resubscribe rather than at once.
 */
const droppedVersions = new Map<string, Uint8Array>()
const DROPPED_VERSIONS_MAX_ENTRIES = 1024

function rememberDropped(key: string, doc: LoroDoc): void {
  droppedVersions.delete(key)
  droppedVersions.set(key, doc.version().encode())
  for (const oldest of droppedVersions.keys()) {
    if (droppedVersions.size <= DROPPED_VERSIONS_MAX_ENTRIES) break
    droppedVersions.delete(oldest)
  }
}

/**
 * The records themselves. Generic over what a record is held as: here a `LoroDoc`,
 * for which giving back is nothing, so no idle time is set and nothing is
 * released for being unused. A cache of engine leases sets both.
 */
const records = new RecordCache<LoroDoc>({
  maxEntries: WORKSPACE_DOC_CACHE_MAX_ENTRIES,
  release: (doc) => {
    releasedForTests?.push(doc)
  },
  pinned: workspaceWriteLockInUse,
  onBoundDrop: (key, doc) => rememberDropped(key, doc),
})

/**
 * Where each cached document last read the record up to.
 *
 * Keyed by the document rather than by workspace id so an eviction needs no
 * second cleanup: the entry goes with the instance, and a replacement starts
 * from the cursor it was opened at.
 */
const followedTo = new WeakMap<LoroDoc, WorkspaceDocCursor>()

/** "Where this document stands is not known" — `catchUp` re-reads the record. */
const COLD_CURSOR: WorkspaceDocCursor = { generation: null, afterSeq: null }

function isCold(cursor: WorkspaceDocCursor): boolean {
  return cursor.generation === null && cursor.afterSeq === null
}

function workspaceDocCacheKey(scope: StoreScope, workspaceId: string): string {
  return `${scope.dataDir}::${workspaceId}`
}

// A workspace record whose stored bytes will not decode is CORRUPTION, and
// every reader should say so with the same structured error the per-document
// path uses — a raw wasm decode error surfaces as an unstructured 500.
//
// A busy database is not: the bytes were never read, so they say nothing about
// the record, and calling them corrupt sends an operator looking for damage
// that is not there. It is rethrown as itself, keeping the `SQLITE_BUSY` code
// a caller matches on.
function rethrowOpenFailure(workspaceId: string, err: unknown): never {
  if (isCorruptStoredDataError(err) || isDatabaseBusy(err)) throw err
  throw corruptStoredData(
    `workspace-tree:${workspaceId}`,
    `workspace record could not be opened (${messageOf(err)})`,
  )
}

/** Test-only: drops every cached live workspace document, simulating a restart. */
export function _clearWorkspaceDocCacheForTests(): void {
  records.clear()
  droppedVersions.clear()
  if (releasedForTests !== null) releasedForTests.length = 0
}

/**
 * Drop the cached live workspace document so the next access reloads from
 * stored bytes. For the failure path where an import mutated the cached doc
 * but persisting it failed — keeping it would serve unpersisted state as
 * though it were durable.
 */
export function evictWorkspaceDocCache(
  workspaceId: string,
  scope: StoreScope = globalStoreScope,
): void {
  const key = workspaceDocCacheKey(scope, workspaceId)
  records.evict(key)
  droppedVersions.delete(key)
}

/**
 * Whether the stored record holds ops `doc` has not seen.
 *
 * One read of the record's persisted frontier and a version-vector compare,
 * which is what `DocumentStoreWorkspaceDocs.save` already does to decide
 * whether there is anything to write. A document that is AHEAD of the record
 * (edits not yet saved) is current; one the record is ahead of, or concurrent
 * with, is not. No bookkeeping of this process's own writes is needed, since a
 * save leaves the record's frontier equal to the document's.
 *
 * Cheaper than asking for the log's cursor by an order of magnitude — the
 * cursor is a four-read transaction — because this runs on every access, not
 * once per pass (scripts/measure/workspace-follow-cost.mjs).
 */
async function recordIsAhead(
  workspaceId: string,
  doc: LoroDoc,
  scope: StoreScope,
): Promise<boolean> {
  const stored = await (await documentStoreReady(scope)).readFrontier({
    docRef: { kind: 'workspace-tree', workspaceId },
  })
  if (stored === null) return false
  const order = doc.oplogVersion().compare(VersionVector.decode(stored.frontier))
  return order === undefined || order < 0
}

/**
 * Read the record's new ops into `doc`, and what the document was before them.
 * Under the workspace write barrier by the caller: it
 * mutates the instance every in-process writer diffs against.
 */
async function importRecord(
  workspaceId: string,
  doc: LoroDoc,
  cursor: WorkspaceDocCursor,
  scope: StoreScope,
): Promise<{ caught: CaughtUp; before: VersionVector }> {
  const before = doc.version()
  const caught = await new DocumentStoreWorkspaceDocs(await documentStoreReady(scope)).catchUp(
    workspaceId,
    doc,
    cursor,
  )
  followedTo.set(doc, caught.cursor)
  return { caught, before }
}

/** Tell the subscribers what `doc` gained since `before`, if anything. */
function announceGain(workspaceId: string, doc: LoroDoc, before: VersionVector): void {
  if (doc.version().compare(before) === 0) return
  emitWorkspaceDocUpdated(workspaceId, doc.export({ mode: 'update', from: before }))
}

/**
 * Bring a cached document level with the record before it is served, and
 * announce what it gained through the same funnel a local save uses — so a
 * browser attached to THIS process hears an edit another process made on
 * whichever access happened to notice it first, rather than only on the
 * tail's schedule.
 *
 * The common answer is "nothing moved", which costs `recordIsAhead`'s one
 * read and takes no lock.
 */
async function followRecord(workspaceId: string, doc: LoroDoc, scope: StoreScope): Promise<void> {
  if (!(await recordIsAhead(workspaceId, doc, scope))) return
  await withWorkspaceWriteLock(workspaceId, async () => {
    const { before } = await importRecord(
      workspaceId,
      doc,
      followedTo.get(doc) ?? COLD_CURSOR,
      scope,
    )
    announceGain(workspaceId, doc, before)
  })
}

/**
 * Open the stored record into a document this process will keep, remembering
 * where it read it to. The position is read BEFORE the record: a write landing
 * between the two leaves the document ahead of its cursor, which costs one
 * idempotent re-import later, while the other order would skip it for good.
 */
async function openFollowed(
  workspaceId: string,
  scope: StoreScope,
  open: (docs: DocumentStoreWorkspaceDocs) => Promise<LoroDoc | null>,
): Promise<LoroDoc | null> {
  const docs = new DocumentStoreWorkspaceDocs(await documentStoreReady(scope))
  const cursor = await docs.readCursor(workspaceId)
  const doc = await open(docs).catch((err) => rethrowOpenFailure(workspaceId, err))
  if (doc === null) return null
  followedTo.set(doc, cursor)
  const key = workspaceDocCacheKey(scope, workspaceId)
  records.keep(key, workspaceId, doc)
  const dropped = droppedVersions.get(key)
  if (dropped !== undefined) {
    droppedVersions.delete(key)
    announceGain(workspaceId, doc, VersionVector.decode(dropped))
  }
  return doc
}

/** A record on loan from the cache: it stays open until the loan is given back. */
interface Lent {
  readonly doc: LoroDoc
  give(): void
}

/**
 * The cached record, lent, caught up with the stored one; opened (and kept) when
 * the cache holds none. The loan is taken before anything is awaited, so the
 * entry being trimmed or evicted meanwhile cannot give the record back under
 * the caller.
 */
async function lendRecord(
  workspaceId: string,
  scope: StoreScope,
  open: (docs: DocumentStoreWorkspaceDocs) => Promise<LoroDoc | null>,
): Promise<Lent | null> {
  const key = workspaceDocCacheKey(scope, workspaceId)
  const held = records.acquire(key)
  if (held !== undefined) {
    try {
      await followRecord(workspaceId, held.handle, scope)
    } catch (err) {
      held.give()
      throw err
    }
    return { doc: held.handle, give: held.give }
  }
  const doc = await openFollowed(workspaceId, scope, open)
  if (doc === null) return null
  // Kept a moment ago; a record already gone from the cache is the caller's alone.
  const lent = records.acquire(key)
  return lent === undefined || lent.handle !== doc
    ? { doc, give: () => {} }
    : { doc, give: lent.give }
}

/**
 * The workspace record AS A DOCUMENT, on loan for the length of `fn`: minted
 * empty inside a registered workspace, like `getWorkspaceDoc`. For the holders
 * that cannot yet read the record through a session; the loan keeps the record
 * from being given back to whatever lent it while they work on it.
 */
export async function withWorkspaceDocument<T>(
  workspaceId: string,
  scope: StoreScope,
  fn: (doc: LoroDoc) => Promise<T>,
): Promise<T> {
  // `create` answers a document, so the loan is never null.
  const lent = (await lendRecord(workspaceId, scope, (docs) => docs.create(workspaceId))) as Lent
  try {
    return await fn(lent.doc)
  } finally {
    lent.give()
  }
}

/**
 * The loans a cache-backed `WorkspaceDocs` has lent to its holders, by the
 * document each lent. The index that holds one releases it through its record
 * kind when its operation is done, and `releaseWorkspaceDocLoan` is that release.
 */
const lentToHolders = new WeakMap<LoroDoc, Lent[]>()

function lendToHolder(lent: Lent | null): LoroDoc | null {
  if (lent === null) return null
  const held = lentToHolders.get(lent.doc) ?? []
  held.push(lent)
  lentToHolders.set(lent.doc, held)
  return lent.doc
}

/** Gives back one loan a cache-backed `WorkspaceDocs` made of `doc`; a document it did not lend is nothing to give back. */
export function releaseWorkspaceDocLoan(doc: LoroDoc): void {
  lentToHolders.get(doc)?.pop()?.give()
}

/** Reads through a loan and gives it back, for a caller that keeps nothing of it. */
function viaLoan(lent: Lent | null): LoroDoc | null {
  lent?.give()
  return lent === null ? null : lent.doc
}

export async function getWorkspaceDoc(
  workspaceId: string,
  scope: StoreScope = globalStoreScope,
): Promise<LoroDoc> {
  // `create` answers a document, so the null arm is unreachable.
  return (await viaLoan(
    await lendRecord(workspaceId, scope, (docs) => docs.create(workspaceId)),
  )) as LoroDoc
}

/** The workspace doc when one is STORED (or cached); null otherwise — a read path must not mint one. */
export async function openWorkspaceDocIfStored(
  workspaceId: string,
  scope: StoreScope = globalStoreScope,
): Promise<LoroDoc | null> {
  return viaLoan(await lendRecord(workspaceId, scope, (docs) => docs.open(workspaceId)))
}

type WorkspaceDocUpdatedListener = (workspaceId: string, update: Uint8Array) => void
const workspaceDocUpdatedListeners = new Set<WorkspaceDocUpdatedListener>()

/**
 * Announce an update this process did NOT persist — one another instance
 * wrote, brought in by the workspace tail.
 *
 * The same funnel a local save uses, deliberately: every subscriber is an SSE
 * stream, and where the bytes came from changes nothing about who needs them.
 * A second path would be a second place for local and tailed writes to fall
 * out of step.
 */
export function emitWorkspaceDocUpdated(workspaceId: string, update: Uint8Array): void {
  for (const listener of workspaceDocUpdatedListeners) {
    try {
      listener(workspaceId, update)
    } catch (err) {
      // A subscriber failing to fan out must never turn a completed save into
      // a failed one, nor stop the other subscribers from being told.
      getLogger('document-store').warning(
        { workspaceId, err },
        'workspace-doc update listener threw; ignoring',
      )
    }
  }
}

/**
 * Subscribe to persisted workspace-document updates. Every mutation path —
 * per-document saves, delete/rename, restore, workspace-granularity imports —
 * funnels through `saveWorkspaceDoc`, so one subscription here is the whole
 * sync fan-out surface. Listeners get the exact bytes the store persisted;
 * importing them into a replica of the workspace document converges it.
 */
export function onWorkspaceDocUpdated(listener: WorkspaceDocUpdatedListener): () => void {
  workspaceDocUpdatedListeners.add(listener)
  return () => workspaceDocUpdatedListeners.delete(listener)
}

export async function saveWorkspaceDoc(
  workspaceId: string,
  doc: LoroDoc,
  scope: StoreScope = globalStoreScope,
): Promise<Uint8Array | null> {
  // The workspaces table is the REGISTRY of workspaces this daemon keeps
  // (workspaceExists reads it to refuse ids it never heard of), and this is
  // the choke point every durable workspace-record write funnels through —
  // including the tree index's createDocument, which never touches
  // saveDocument. Without this, a workspace minted by an MCP tool has a
  // stored record but no registry row, and the workspace-document route refuses it (404).
  await upsertWorkspaceRow(await scope.db(), workspaceId)
  const docs = new DocumentStoreWorkspaceDocs(await documentStoreReady(scope))
  let update: Uint8Array | null
  try {
    update = await docs.save(workspaceId, doc)
  } catch (err) {
    // The live workspace doc now carries ops durable storage refused. Serving
    // it as though persisted would resurrect exactly the unpersisted-state bug
    // eviction exists to prevent — drop it so the next read reloads stored bytes.
    evictWorkspaceDocCache(workspaceId, scope)
    throw err
  }
  // Through the shared funnel rather than a second loop: a remote update
  // brought in by the workspace tail announces itself the same way, and one
  // of the two copies would eventually stop matching the other.
  if (update !== null) emitWorkspaceDocUpdated(workspaceId, update)
  return update
}

/**
 * Bring the cached workspace document up to the stored record, answering the
 * position it now stands at.
 *
 * For a reader that must judge against the RECORD rather than this
 * instance's view of it — file-GC being the one that matters, since it acts
 * destructively on what it decides is unreferenced.
 *
 * A workspace with nothing cached needs no catch-up: the next open reads the
 * store. Answering its cursor anyway keeps the two callers of this symmetric,
 * so a fence taken around a pass compares like with like either way.
 */
export async function catchUpWorkspaceDoc(
  workspaceId: string,
  scope: StoreScope = globalStoreScope,
): Promise<WorkspaceDocCursor> {
  const docs = cacheBackedWorkspaceDocs(scope)
  const cached = records.get(workspaceDocCacheKey(scope, workspaceId))
  if (cached === undefined) return docs.readCursor(workspaceId)
  // A COLD cursor, not the record's current one. Nothing tracks where the
  // cached document stands — it is mutated in place by every local write —
  // so the only honest answer is "I do not know", which is what
  // `{null, null}` says. `catchUp` reads that as a generation mismatch and
  // reconciles from the snapshot, which is the whole point: passing the
  // record's current cursor instead would say "already up to date" and
  // import nothing, leaving the caller with exactly the stale view it asked
  // to be rid of.
  const before = cached.version()
  const { cursor } = await docs.catchUp(workspaceId, cached, COLD_CURSOR)
  // Nobody else is told what this imported, so say it here: a subscriber that
  // missed these ops would otherwise never get them, since the next
  // access finds the document already level and has nothing to announce.
  announceGain(workspaceId, cached, before)
  return cursor
}

/**
 * `WorkspaceDocs` over THIS module's live cache — every consumer that
 * operates on a workspace document through it (the tree index used by
 * delete/rename, the dual-plane index) shares the same instance the save
 * path diffs against, so no path can leave another holding a stale doc.
 */
export function cacheBackedWorkspaceDocs(scope: StoreScope = globalStoreScope): WorkspaceDocs {
  return {
    // Lent until the holder releases it (`releaseWorkspaceDocLoan`), so the record
    // an index works on is not given back while it works.
    open: async (workspaceId) =>
      lendToHolder(await lendRecord(workspaceId, scope, (docs) => docs.open(workspaceId))),
    create: async (workspaceId) =>
      lendToHolder(
        await lendRecord(workspaceId, scope, (docs) => docs.create(workspaceId)),
      ) as LoroDoc,
    save: (workspaceId, doc) => saveWorkspaceDoc(workspaceId, doc, scope),
    // The tailing half is a STORE concern, so it delegates rather than being
    // reimplemented against the cache: the cursor describes the record, and
    // the only thing this wrapper adds is which doc gets caught up.
    readCursor: async (workspaceId) =>
      new DocumentStoreWorkspaceDocs(await documentStoreReady(scope)).readCursor(workspaceId),
    storedVersion: async (workspaceId) =>
      new DocumentStoreWorkspaceDocs(await documentStoreReady(scope)).storedVersion(workspaceId),
    // Under the workspace write barrier, because this MUTATES the live cached
    // document that every in-process writer is diffing against. Importing
    // another instance's ops into it while a local save is computing its own
    // delta is the one way a catch-up could make things worse rather than
    // better.
    //
    // A caller that knows where it stands and finds the document already level
    // with the record is answered without reading the log: an access has
    // usually caught the document up since, and the tail pass that asks is the
    // common case (its idle price is this one read per workspace). A COLD
    // cursor is the caller saying it does not know, and always reads.
    catchUp: async (workspaceId, doc, cursor) => {
      if (!isCold(cursor) && !(await recordIsAhead(workspaceId, doc, scope))) {
        return { cursor, updates: [] }
      }
      return withWorkspaceWriteLock(
        workspaceId,
        async () => (await importRecord(workspaceId, doc, cursor, scope)).caught,
      )
    },
  }
}

/**
 * `compactionCut` over a live record: its frontiers are turned into version
 * vectors here, where the op log is, and the cut is turned back. A point the
 * record does not hold has no vector, and then there is nothing to cut.
 */
export function compactionCutOfDoc(doc: LoroDoc, points: readonly Frontiers[]): Frontiers | null {
  let vectors: Array<Map<string, number>>
  try {
    vectors = points.map((point) => new Map<string, number>(doc.frontiersToVV(point).toJSON()))
  } catch {
    return null
  }
  // The root's own vector, not `shallowSinceVV()`: that one stops one op short
  // of the root, so a cut one op before the root compared equal to it.
  const root = new Map<string, number>(doc.frontiersToVV(doc.shallowSinceFrontiers()).toJSON())
  const cut = compactionCut(vectors, root)
  return cut === null
    ? null
    : doc.vvToFrontiers(VersionVector.parseJSON(new Map(cut) as Map<PeerID, number>))
}

/**
 * The cached record bound to its operations and its save, for the duration of
 * `fn`: `null` when nothing is stored. A reader that holds the record only
 * through the session is ignorant of what holds it, and the bracket is where
 * the holder is acquired and given back — which a `LoroDoc` needs neither of.
 */
export async function withStoredWorkspaceRecord<T>(
  workspaceId: string,
  scope: StoreScope,
  fn: (record: RecordSession | null) => Promise<T>,
): Promise<T> {
  const lent = await lendRecord(workspaceId, scope, (docs) => docs.open(workspaceId))
  return heldFor(lent === null ? null : sessionOver(workspaceId, lent, scope), fn)
}

/**
 * The live workspace record for the length of `fn`: minted empty inside a
 * registered workspace, like `getWorkspaceDoc`, and given back when `fn`
 * returns or throws. The cache counts the bracket as a user, so the record is
 * not given back to whatever lent it while the bracket reads it, whatever the
 * cache does with its entry meanwhile.
 */
export async function withWorkspaceRecord<T>(
  workspaceId: string,
  scope: StoreScope,
  fn: (record: RecordSession) => Promise<T>,
): Promise<T> {
  // `create` answers a document, so the loan is never null.
  const lent = (await lendRecord(workspaceId, scope, (docs) => docs.create(workspaceId))) as Lent
  return heldFor(sessionOver(workspaceId, lent, scope), fn)
}

/** Runs `fn` on `session` and releases it however `fn` ends; a missing record is handed over as `null`. */
async function heldFor<S extends RecordSession | null, T>(
  session: S,
  fn: (record: S) => Promise<T>,
): Promise<T> {
  try {
    return await fn(session)
  } finally {
    session?.release()
  }
}

/**
 * The record holding exactly what the store persisted, which under the
 * workspace write barrier is the rule: every in-process write persists before
 * it releases the barrier, and the access caught the cache up with any other
 * process's. The one read that checks is the record's persisted frontier. A
 * cache holding ops the store does not — a caller inside the barrier that has
 * not saved yet — falls back to the stored record, so a frontier saved from it
 * never names an op a restart would lose.
 */
export async function withPersistedWorkspaceRecord<T>(
  workspaceId: string,
  scope: StoreScope,
  fn: (record: RecordSession | null) => Promise<T>,
): Promise<T> {
  const lent = await lendRecord(workspaceId, scope, (docs) => docs.open(workspaceId))
  if (lent === null) return fn(null)
  const store = await documentStoreReady(scope)
  const stored = await store.readFrontier({ docRef: { kind: 'workspace-tree', workspaceId } })
  if (
    stored !== null &&
    lent.doc.oplogVersion().compare(VersionVector.decode(stored.frontier)) === 0
  ) {
    return heldFor(sessionOver(workspaceId, lent, scope), fn)
  }
  // The cache holds ops the store does not: the stored record is read instead, a
  // document of its own that no cache lent.
  lent.give()
  const persisted = await new DocumentStoreWorkspaceDocs(
    new LibsqlDocumentStore(await scope.db()),
  ).open(workspaceId)
  return heldFor(
    persisted === null ? null : sessionOver(workspaceId, { doc: persisted, give: () => {} }, scope),
    fn,
  )
}

function sessionOver(workspaceId: string, lent: Lent, scope: StoreScope): RecordSession {
  return bindRecordOps(
    legacyRecordOps,
    lent.doc,
    async (held) => {
      await saveWorkspaceDoc(workspaceId, held, scope)
    },
    lent.give,
  )
}

// ── load LoroDoc, returning an empty document when no snapshot exists ──
export async function loadDocument(
  workspaceId: string,
  path: string,
  scope: StoreScope = globalStoreScope,
): Promise<LoroDoc> {
  return (await loadPlacedDocument(workspaceId, path, scope)) ?? new LoroDoc()
}

/** The document the tree places at `path`, or `null` when it places none there. */
async function loadPlacedDocument(
  workspaceId: string,
  path: string,
  scope: StoreScope,
): Promise<LoroDoc | null> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  // The workspace tree answers first, and resolves the PATH itself:
  // the tree is the address book now, so a document lists and serves even
  // if its mirror row is skewed or gone. The projection is a VALUE copy
  // with its own oplog.
  const workspaceDoc = await openWorkspaceDocIfStored(workspaceId, scope)
  if (workspaceDoc === null) return null
  const entry = resolveWorkspaceDocument(workspaceDoc, path)
  if (entry === null) return null
  return projectWorkspaceDocument(workspaceDoc, entry.documentId) ?? new LoroDoc()
}
