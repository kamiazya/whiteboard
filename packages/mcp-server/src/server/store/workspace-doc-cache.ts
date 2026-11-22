import {
  bindRecordOps,
  documentFromSnapshot,
  type LegacyRecord,
  loroDocKind,
  type RecordSession,
} from '@kamiazya/whiteboard-loro-adapter'
import { messageOf } from '@kamiazya/whiteboard-model'
import { isDatabaseBusy } from '@kamiazya/whiteboard-ports'
import {
  type CaughtUp,
  type IndexRecordKind,
  RecordStoreWorkspaceDocs,
  type WorkspaceDocCursor,
  type WorkspaceDocs,
} from '@kamiazya/whiteboard-workspace-index'
import { getLogger } from '../log.js'
import { validateDocumentPath, validateWorkspaceId } from '../validators.js'
import { corruptStoredData, isCorruptStoredDataError } from './corrupt-stored-data.js'
import { upsertWorkspaceRow } from './db/upsert-workspace.js'
import { RecordCache } from './record-cache.js'
import { scheduleIdleRelease } from './record-idle-release.js'
import { documentStoreReady } from './store-handles.js'
import { globalStoreScope, type StoreScope } from './store-scope.js'
import { withWorkspaceWriteLock, workspaceWriteLockInUse } from './workspace-lock.js'
import { WORKSPACE_RECORD_KIND } from './workspace-record-kind.js'

/**
 * The live WORKSPACE records this process serves and writes through, one
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

// A record is held as `object`: what it is (an engine lease) is
// `workspace-record-kind.ts`'s business, and nothing here reads a record except
// through it.
type Held = object

const recordKind = () => WORKSPACE_RECORD_KIND

// What giving a record back is seen as by a test that wants to watch the loans of
// a record end.
let releasedForTests: Held[] | null = null

/** Test-only: how many loans of a record are out right now. */
export function _workspaceRecordLoansForTests(): number {
  return records?.outstanding ?? 0
}

/**
 * Test-only: starts counting the loans taken of each record from here on, and
 * answers how many a record has out. For a test that asks what an operation
 * itself held, which the process-wide count mixes with every other loan.
 */
export function _watchWorkspaceRecordLoansForTests(): {
  /** How many loans are out of the records watched so far. */
  total(): number
  /** How many loans were taken at all, so a count of none is not an empty watch. */
  taken(): number
} {
  const watch = { counts: new Map<object, number>(), taken: 0 }
  loanWatch = watch
  return {
    total: () => [...watch.counts.values()].reduce((sum, held) => sum + held, 0),
    taken: () => watch.taken,
  }
}

let loanWatch: { counts: Map<object, number>; taken: number } | null = null

/** Test-only: the record the cache holds for a workspace right now, without counting a use; `undefined` when none is held. */
export function _heldWorkspaceRecordForTests(
  workspaceId: string,
  scope: StoreScope = globalStoreScope,
): Held | undefined {
  return records?.get(workspaceDocCacheKey(scope, workspaceId))
}

/** Test-only: the records the cache has given back since this was first asked for. */
export function _workspaceRecordReleasesForTests(): Held[] {
  releasedForTests ??= []
  return releasedForTests
}

/**
 * How many workspace records stay resident, least recently used dropped first.
 *
 * Without a bound every record the process ever opened stayed for its
 * lifetime — the daily file-GC sweep opens every workspace it keeps — and in
 * server mode one process serves every tenant over one WASM heap.
 * The count is `workspace-record-kind.ts`'s, with the measurement behind it.
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
export function workspaceDocCacheMaxEntries(): number {
  return recordKind().maxEntries
}

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

function rememberDropped(key: string, record: Held): void {
  droppedVersions.delete(key)
  droppedVersions.set(key, recordKind().index.encodedVersion(record))
  for (const oldest of droppedVersions.keys()) {
    if (droppedVersions.size <= DROPPED_VERSIONS_MAX_ENTRIES) break
    droppedVersions.delete(oldest)
  }
}

/** The records themselves, bounded, and dropped when nobody has used one for a while. */
let records: RecordCache<Held> | undefined

function recordCache(): RecordCache<Held> {
  if (records !== undefined) return records
  const kind = recordKind()
  records = new RecordCache<Held>({
    maxEntries: kind.maxEntries,
    idleMs: kind.idleMs,
    schedule: scheduleIdleRelease,
    release: (record) => {
      kind.index.release(record)
      releasedForTests?.push(record)
    },
    pinned: workspaceWriteLockInUse,
    onLoan: (record, change) => {
      if (loanWatch === null) return
      loanWatch.counts.set(record, (loanWatch.counts.get(record) ?? 0) + change)
      if (change === 1) loanWatch.taken += 1
    },
    onLapse: (key, record) => rememberDropped(key, record),
  })
  return records
}

/**
 * Where each cached document last read the record up to.
 *
 * Keyed by the document rather than by workspace id so an eviction needs no
 * second cleanup: the entry goes with the instance, and a replacement starts
 * from the cursor it was opened at.
 */
const followedTo = new WeakMap<Held, WorkspaceDocCursor>()

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
  records?.clear()
  droppedVersions.clear()
  loanWatch = null
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
  records?.evict(key)
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
  record: Held,
  scope: StoreScope,
): Promise<boolean> {
  const stored = await (await documentStoreReady(scope)).readFrontier({
    docRef: { kind: 'workspace-tree', workspaceId },
  })
  if (stored === null) return false
  const order = recordKind().index.compareVersion(record, stored.frontier)
  return order === 'behind' || order === 'concurrent'
}

/** The stored record as this process's kind reads it. */
async function storedDocs(scope: StoreScope): Promise<RecordStoreWorkspaceDocs<Held>> {
  return new RecordStoreWorkspaceDocs<Held>(await documentStoreReady(scope), recordKind().index)
}

/**
 * Read the record's new ops into `doc`, and what the document was before them.
 * Under the workspace write barrier by the caller: it
 * mutates the instance every in-process writer diffs against.
 */
async function importRecord(
  workspaceId: string,
  record: Held,
  cursor: WorkspaceDocCursor,
  scope: StoreScope,
): Promise<{ caught: CaughtUp; before: Uint8Array }> {
  const before = recordKind().index.encodedVersion(record)
  const caught = await (await storedDocs(scope)).catchUp(workspaceId, record, cursor)
  followedTo.set(record, caught.cursor)
  return { caught, before }
}

/** Tell the subscribers what `record` gained since the version `before` encodes, if anything. */
function announceGain(workspaceId: string, record: Held, before: Uint8Array): void {
  const kind = recordKind().index
  if (kind.atVersion(record, before)) return
  emitWorkspaceDocUpdated(workspaceId, kind.exportUpdateSince(record, before))
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
async function followRecord(workspaceId: string, record: Held, scope: StoreScope): Promise<void> {
  if (!(await recordIsAhead(workspaceId, record, scope))) return
  await withWorkspaceWriteLock(workspaceId, async () => {
    const { before } = await importRecord(
      workspaceId,
      record,
      followedTo.get(record) ?? COLD_CURSOR,
      scope,
    )
    announceGain(workspaceId, record, before)
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
  open: (docs: RecordStoreWorkspaceDocs<Held>) => Promise<Held | null>,
): Promise<Held | null> {
  const docs = await storedDocs(scope)
  const cursor = await docs.readCursor(workspaceId)
  const record = await open(docs).catch((err) => rethrowOpenFailure(workspaceId, err))
  if (record === null) return null
  followedTo.set(record, cursor)
  const key = workspaceDocCacheKey(scope, workspaceId)
  recordCache().keep(key, workspaceId, record)
  const dropped = droppedVersions.get(key)
  if (dropped !== undefined) {
    droppedVersions.delete(key)
    announceGain(workspaceId, record, dropped)
  }
  return record
}

/** A record on loan from the cache: it stays open until the loan is given back. */
interface Lent {
  readonly doc: Held
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
  open: (docs: RecordStoreWorkspaceDocs<Held>) => Promise<Held | null>,
): Promise<Lent | null> {
  const key = workspaceDocCacheKey(scope, workspaceId)
  const held = recordCache().acquire(key)
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
  // Kept a moment ago; a record already gone from the cache is the caller's
  // alone, and a different one kept under the key since is a loan nobody wants.
  const lent = recordCache().acquire(key)
  if (lent?.handle === doc) return { doc, give: lent.give }
  lent?.give()
  return { doc, give: () => {} }
}

/**
 * Brings the live workspace record level with the stored one, from where a
 * follower last read it, and answers the bytes its audience has not been sent.
 *
 * `cursor` is where the follower stood, or `undefined` on first sight. A client
 * is sent the live record when it subscribes, and that record can be OLDER than
 * the stored one — loaded before another instance wrote. Baselining at the
 * stored cursor would skip that gap for good, so on first sight the record is
 * reconciled from the store (a cold cursor, which `catchUp` answers by re-reading
 * it) and only what it GAINED goes out: the client already holds the rest. One
 * instance's own cache is level with the store, so that sends nothing there.
 *
 * The record is lent for the whole catch-up and what it gained is read off it
 * here, so a follower sees cursors and bytes and never the record.
 */
export async function followWorkspaceRecord(
  workspaceId: string,
  scope: StoreScope,
  cursor: WorkspaceDocCursor | undefined,
): Promise<CaughtUp> {
  // `create` answers a record, so the loan is never null.
  const lent = (await lendRecord(workspaceId, scope, (docs) => docs.create(workspaceId))) as Lent
  try {
    const docs = cacheBackedWorkspaceDocs(scope)
    if (cursor !== undefined) return await docs.catchUp(workspaceId, lent.doc, cursor)
    const kind = recordKind().index
    const before = kind.encodedVersion(lent.doc)
    const reconciled = await docs.catchUp(workspaceId, lent.doc, COLD_CURSOR)
    const gained = kind.atVersion(lent.doc, before)
      ? []
      : [kind.exportUpdateSince(lent.doc, before)]
    return { cursor: reconciled.cursor, updates: gained }
  } finally {
    lent.give()
  }
}

/**
 * The loans a cache-backed `WorkspaceDocs` has lent to its holders, by the
 * document each lent. The index that holds one releases it through its record
 * kind when its operation is done, and `releaseWorkspaceDocLoan` is that release.
 */
const lentToHolders = new WeakMap<Held, Lent[]>()

function lendToHolder(lent: Lent | null): Held | null {
  if (lent === null) return null
  const held = lentToHolders.get(lent.doc) ?? []
  held.push(lent)
  lentToHolders.set(lent.doc, held)
  return lent.doc
}

/** Gives back one loan a cache-backed `WorkspaceDocs` made of `doc`; a document it did not lend is nothing to give back. */
export function releaseWorkspaceDocLoan(doc: Held): void {
  lentToHolders.get(doc)?.pop()?.give()
}

/** The active kind as an index runs over it: the record it operates on is given back to the cache, not freed. */
export function cacheBackedRecordKind(): IndexRecordKind<Held> {
  return { ...recordKind().index, release: releaseWorkspaceDocLoan }
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
 * funnels through `saveRecord`, so one subscription here is the whole
 * sync fan-out surface. Listeners get the exact bytes the store persisted;
 * importing them into a replica of the workspace document converges it.
 */
export function onWorkspaceDocUpdated(listener: WorkspaceDocUpdatedListener): () => void {
  workspaceDocUpdatedListeners.add(listener)
  return () => workspaceDocUpdatedListeners.delete(listener)
}

async function saveRecord(
  workspaceId: string,
  doc: Held,
  scope: StoreScope,
): Promise<Uint8Array | null> {
  // The workspaces table is the REGISTRY of workspaces this daemon keeps
  // (workspaceExists reads it to refuse ids it never heard of), and this is
  // the choke point every durable workspace-record write funnels through —
  // including the tree index's createDocument, which never touches
  // saveDocument. Without this, a workspace minted by an MCP tool has a
  // stored record but no registry row, and the workspace-document route refuses it (404).
  await upsertWorkspaceRow(await scope.db(), workspaceId)
  const docs = await storedDocs(scope)
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
  const cached = recordCache().get(workspaceDocCacheKey(scope, workspaceId))
  if (cached === undefined) return docs.readCursor(workspaceId)
  // A COLD cursor, not the record's current one. Nothing tracks where the
  // cached document stands — it is mutated in place by every local write —
  // so the only honest answer is "I do not know", which is what
  // `{null, null}` says. `catchUp` reads that as a generation mismatch and
  // reconciles from the snapshot, which is the whole point: passing the
  // record's current cursor instead would say "already up to date" and
  // import nothing, leaving the caller with exactly the stale view it asked
  // to be rid of.
  const before = recordKind().index.encodedVersion(cached)
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
export function cacheBackedWorkspaceDocs(
  scope: StoreScope = globalStoreScope,
): WorkspaceDocs<Held> {
  return {
    // Lent until the holder releases it (`releaseWorkspaceDocLoan`), so the record
    // an index works on is not given back while it works.
    open: async (workspaceId) =>
      lendToHolder(await lendRecord(workspaceId, scope, (docs) => docs.open(workspaceId))),
    create: async (workspaceId) =>
      lendToHolder(
        await lendRecord(workspaceId, scope, (docs) => docs.create(workspaceId)),
      ) as Held,
    save: (workspaceId, doc) => saveRecord(workspaceId, doc, scope),
    // The tailing half is a STORE concern, so it delegates rather than being
    // reimplemented against the cache: the cursor describes the record, and
    // the only thing this wrapper adds is which doc gets caught up.
    readCursor: async (workspaceId) => (await storedDocs(scope)).readCursor(workspaceId),
    storedVersion: async (workspaceId) => (await storedDocs(scope)).storedVersion(workspaceId),
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
 * The cached record bound to its operations and its save, for the duration of
 * `fn`: `null` when nothing is stored. A reader that holds the record only
 * through the session is ignorant of what holds it, and the bracket is where
 * the holder is acquired and given back.
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
 * registered workspace, and given back when `fn`
 * returns or throws. The cache counts the bracket as a user, so the record is
 * not given back to whatever lent it while the bracket reads it, whatever the
 * cache does with its entry meanwhile.
 */
export async function withWorkspaceRecord<T>(
  workspaceId: string,
  scope: StoreScope,
  fn: (record: RecordSession) => Promise<T>,
): Promise<T> {
  // `create` answers a record, so the loan is never null.
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
  if (stored !== null && recordKind().index.compareVersion(lent.doc, stored.frontier) === 'equal') {
    return heldFor(sessionOver(workspaceId, lent, scope), fn)
  }
  // The cache holds ops the store does not: the stored record is read instead, a
  // record of its own that no cache lent, so the bracket that reads it frees it.
  lent.give()
  const persisted = await (await storedDocs(scope)).open(workspaceId)
  const kind = recordKind().index
  return heldFor(
    persisted === null
      ? null
      : sessionOver(workspaceId, { doc: persisted, give: () => kind.release(persisted) }, scope),
    fn,
  )
}

function sessionOver(workspaceId: string, lent: Lent, scope: StoreScope): RecordSession {
  return bindRecordOps(
    recordKind().ops,
    lent.doc,
    async (held) => {
      await saveRecord(workspaceId, held, scope)
    },
    lent.give,
  )
}

// ── load LoroDoc, returning an empty document when no snapshot exists ──
export async function loadDocument(
  workspaceId: string,
  path: string,
  scope: StoreScope = globalStoreScope,
): Promise<LegacyRecord> {
  return (await loadPlacedDocument(workspaceId, path, scope)) ?? loroDocKind.empty()
}

const assertedAs = <T>() => ({ parse: (value: unknown) => value as T })

/** The document the tree places at `path`, or `null` when it places none there. */
async function loadPlacedDocument(
  workspaceId: string,
  path: string,
  scope: StoreScope,
): Promise<LegacyRecord | null> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  // The workspace tree answers first, and resolves the PATH itself:
  // the tree is the address book now, so a document lists and serves even
  // if its mirror row is skewed or gone. The projection is a VALUE copy
  // with its own oplog.
  return withStoredWorkspaceRecord(workspaceId, scope, async (record) => {
    if (record === null) return null
    const entry = await record.read(
      { query: 'workspaceDocumentEntry', args: { path } },
      assertedAs<{ documentId: string } | null>(),
    )
    if (entry === null) return null
    const projected = record.exportProjection(entry.documentId)
    return projected === null ? loroDocKind.empty() : documentFromSnapshot(projected)
  })
}
