import { messageOf } from '@kamiazya/whiteboard-model'
import { isDatabaseBusy } from '@kamiazya/whiteboard-ports'
import {
  type CaughtUp,
  DocumentStoreWorkspaceDocs,
  type WorkspaceDocCursor,
  type WorkspaceDocs,
} from '@kamiazya/whiteboard-workspace-index'
import { type LoroDoc, VersionVector } from 'loro-crdt'
import { getLogger } from '../log.js'
import { corruptStoredData, isCorruptStoredDataError } from './corrupt-stored-data.js'
import { upsertWorkspaceRow } from './db/upsert-workspace.js'
import { evictWorkspaceDocs } from './doc-cache.js'
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
const workspaceDocCache = new Map<string, { workspaceId: string; doc: LoroDoc }>()

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
 * seen by nobody here. Two things derived from the record would then be
 * wrong, and `openFollowed` settles both when it reopens one. The per-document
 * projections in `doc-cache.ts` were cut from the OLD record, so a hit would
 * serve the content from before that write and the next save of it would
 * write that content back over it — they are evicted on every open that
 * misses, which covers an explicit eviction as well as this bound. And the
 * subscribers were told only what the old instance held, while a reopened
 * instance already level with the record gives `followRecord` nothing to
 * announce — so the version a record was dropped at is kept
 * (`droppedVersions`) and its gain is announced on reopen.
 * `followedTo` is keyed by the instance and leaves with it.
 *
 * ponytail: a bound by count, not bytes. A byte-weighted bound needs a size
 * this module does not have on a hit without an export, which is O(record).
 */
export const WORKSPACE_DOC_CACHE_MAX_ENTRIES = 16

function cachedRecord(key: string): LoroDoc | undefined {
  const entry = workspaceDocCache.get(key)
  if (entry === undefined) return undefined
  // Reinserted so Map order is recency order, oldest first.
  workspaceDocCache.delete(key)
  workspaceDocCache.set(key, entry)
  // A record kept past the bound because its lock was in use is trimmed by
  // whichever access comes next, so the cache returns to the bound once
  // the lock is released rather than staying over it until another miss.
  trimToBound(key)
  return entry.doc
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

function rememberDropped(key: string, doc: LoroDoc): void {
  droppedVersions.delete(key)
  droppedVersions.set(key, doc.version().encode())
  for (const oldest of droppedVersions.keys()) {
    if (droppedVersions.size <= DROPPED_VERSIONS_MAX_ENTRIES) break
    droppedVersions.delete(oldest)
  }
}

function keepRecord(key: string, workspaceId: string, doc: LoroDoc): void {
  workspaceDocCache.delete(key)
  workspaceDocCache.set(key, { workspaceId, doc })
  trimToBound(key)
}

/** Drops least recently used records over the bound, never `keep` nor a locked one. */
function trimToBound(keep: string): void {
  let excess = workspaceDocCache.size - WORKSPACE_DOC_CACHE_MAX_ENTRIES
  for (const [candidate, entry] of workspaceDocCache) {
    if (excess <= 0) break
    if (candidate === keep || workspaceWriteLockInUse(entry.workspaceId)) continue
    workspaceDocCache.delete(candidate)
    rememberDropped(candidate, entry.doc)
    excess -= 1
  }
}

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
  workspaceDocCache.clear()
  droppedVersions.clear()
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
  workspaceDocCache.delete(key)
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
 * Read the record's new ops into `doc` and say what that did to everything
 * derived from it. Under the workspace write barrier by the caller: it
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
  // Every per-document projection is a value cut from this record, so one
  // taken before the ops arrived serves the old content for good — and a
  // later save of it would diff the old content against the tree and revert
  // what arrived. Only a real gain evicts: this process's own writes come back
  // through here as ops the document already has.
  if (doc.version().compare(before) !== 0) evictWorkspaceDocs(workspaceId, scope)
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
  keepRecord(key, workspaceId, doc)
  evictWorkspaceDocs(workspaceId, scope)
  const dropped = droppedVersions.get(key)
  if (dropped !== undefined) {
    droppedVersions.delete(key)
    announceGain(workspaceId, doc, VersionVector.decode(dropped))
  }
  return doc
}

export async function getWorkspaceDoc(
  workspaceId: string,
  scope: StoreScope = globalStoreScope,
): Promise<LoroDoc> {
  const cached = cachedRecord(workspaceDocCacheKey(scope, workspaceId))
  if (cached !== undefined) {
    await followRecord(workspaceId, cached, scope)
    return cached
  }
  // `create` answers a document, so the null arm is unreachable.
  return (await openFollowed(workspaceId, scope, (docs) => docs.create(workspaceId))) as LoroDoc
}

/** The workspace doc when one is STORED (or cached); null otherwise — a read path must not mint one. */
export async function openWorkspaceDocIfStored(
  workspaceId: string,
  scope: StoreScope = globalStoreScope,
): Promise<LoroDoc | null> {
  const cached = cachedRecord(workspaceDocCacheKey(scope, workspaceId))
  if (cached !== undefined) {
    await followRecord(workspaceId, cached, scope)
    return cached
  }
  return openFollowed(workspaceId, scope, (docs) => docs.open(workspaceId))
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
    // The live workspace doc now carries ops durable storage refused, and
    // every cached projection derives from it. Serving either as though
    // persisted would resurrect exactly the unpersisted-state bug eviction
    // exists to prevent — drop both so the next read reloads stored bytes.
    evictWorkspaceDocCache(workspaceId, scope)
    evictWorkspaceDocs(workspaceId, scope)
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
  const cached = cachedRecord(workspaceDocCacheKey(scope, workspaceId))
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
    open: (workspaceId) => openWorkspaceDocIfStored(workspaceId, scope),
    create: (workspaceId) => getWorkspaceDoc(workspaceId, scope),
    save: (workspaceId, doc) => saveWorkspaceDoc(workspaceId, doc, scope),
    // The tailing half is a STORE concern, so it delegates rather than being
    // reimplemented against the cache: the cursor describes the record, and
    // the only thing this wrapper adds is which doc gets caught up.
    readCursor: async (workspaceId) =>
      new DocumentStoreWorkspaceDocs(await documentStoreReady(scope)).readCursor(workspaceId),
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
