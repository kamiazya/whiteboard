import {
  DocumentStoreWorkspaceDocs,
  type WorkspaceDocCursor,
  type WorkspaceDocs,
} from '@kamiazya/whiteboard-workspace-index'
import type { LoroDoc } from 'loro-crdt'
import { errorMessage } from '../../shared/error-message.js'
import { getDataDir } from '../config.js'
import { getLogger } from '../log.js'
import { corruptStoredData, isCorruptStoredDataError } from './corrupt-stored-data.js'
import { upsertWorkspaceRow } from './db/upsert-workspace.js'
import { evictWorkspaceDocs } from './doc-cache.js'
import { dbReady, documentStoreReady } from './store-handles.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

/**
 * The live WORKSPACE documents this process serves and writes through, one
 * per workspace. This is the daemon's twin of the browser backend holding
 * its workspace doc across a session: `DocumentStoreWorkspaceDocs.open`
 * reads the whole stored record, so opening per save would cost
 * O(workspace) on every keystroke burst, while the incremental `save`
 * exports only what moved.
 *
 * Keyed by data dir AS WELL as workspace id because tests point
 * `getDataDir()` at a fresh directory per test; a cache keyed by workspace
 * alone would carry one test's document tree into the next test's empty
 * database. In production there is one data dir for the process lifetime.
 *
 * Coherence rule: every content write flows through the cached instance
 * (saveDocument diffs the caller's doc against it), so it can only go stale
 * when a path WRITES THE STORED RECORD directly — the tree index used by
 * delete/rename does — and those paths drop the entry so the next
 * operation reopens the merged state.
 */
const workspaceDocCache = new Map<string, LoroDoc>()

function workspaceDocCacheKey(workspaceId: string): string {
  return `${getDataDir()}::${workspaceId}`
}

// A workspace record whose stored bytes will not decode is CORRUPTION, and
// every reader should say so with the same structured error the per-document
// path uses — a raw wasm decode error surfaces as an unstructured 500.
export function throwWorkspaceRecordCorrupt(workspaceId: string, err: unknown): never {
  if (isCorruptStoredDataError(err)) throw err
  throw corruptStoredData(
    `workspace-tree:${workspaceId}`,
    `workspace record could not be opened (${errorMessage(err)})`,
  )
}

/** Test-only: drops every cached live workspace document, simulating a restart. */
export function _clearWorkspaceDocCacheForTests(): void {
  workspaceDocCache.clear()
}

/**
 * Drop the cached live workspace document so the next access reloads from
 * stored bytes. For the failure path where an import mutated the cached doc
 * but persisting it failed — keeping it would serve unpersisted state as
 * though it were durable.
 */
export function evictWorkspaceDocCache(workspaceId: string): void {
  workspaceDocCache.delete(workspaceDocCacheKey(workspaceId))
}

export async function getWorkspaceDoc(workspaceId: string): Promise<LoroDoc> {
  const key = workspaceDocCacheKey(workspaceId)
  const cached = workspaceDocCache.get(key)
  if (cached !== undefined) return cached
  const docs = new DocumentStoreWorkspaceDocs(await documentStoreReady())
  const doc = await docs
    .create(workspaceId)
    .catch((err) => throwWorkspaceRecordCorrupt(workspaceId, err))
  workspaceDocCache.set(key, doc)
  return doc
}

/** The workspace doc when one is STORED (or cached); null otherwise — a read path must not mint one. */
export async function openWorkspaceDocIfStored(workspaceId: string): Promise<LoroDoc | null> {
  const key = workspaceDocCacheKey(workspaceId)
  const cached = workspaceDocCache.get(key)
  if (cached !== undefined) return cached
  const docs = new DocumentStoreWorkspaceDocs(await documentStoreReady())
  const doc = await docs
    .open(workspaceId)
    .catch((err) => throwWorkspaceRecordCorrupt(workspaceId, err))
  if (doc !== null) workspaceDocCache.set(key, doc)
  return doc
}

type WorkspaceDocUpdatedListener = (workspaceId: string, update: Uint8Array) => void
const workspaceDocUpdatedListeners = new Set<WorkspaceDocUpdatedListener>()

/**
 * Announce an update this process did NOT persist — one another instance
 * wrote, brought in by the workspace tail.
 *
 * The same funnel a local save uses, deliberately: the subscribers are a
 * websocket fan-out and an SSE stream, and where the bytes came from changes
 * nothing about who needs them. A second path would be a second place for the
 * two transports to fall out of step.
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
): Promise<Uint8Array | null> {
  // The workspaces table is the REGISTRY of workspaces this daemon keeps
  // (workspaceExists reads it to refuse ids it never heard of), and this is
  // the choke point every durable workspace-record write funnels through —
  // including the tree index's createDocument, which never touches
  // saveDocument. Without this, a workspace minted by an MCP tool has a
  // stored record but no registry row, and the WS route refuses it (4404).
  await upsertWorkspaceRow(await dbReady(), workspaceId)
  const docs = new DocumentStoreWorkspaceDocs(await documentStoreReady())
  let update: Uint8Array | null
  try {
    update = await docs.save(workspaceId, doc)
  } catch (err) {
    // The live workspace doc now carries ops durable storage refused, and
    // every cached projection derives from it. Serving either as though
    // persisted would resurrect exactly the unpersisted-state bug eviction
    // exists to prevent — drop both so the next read reloads stored bytes.
    evictWorkspaceDocCache(workspaceId)
    evictWorkspaceDocs(workspaceId)
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
export async function catchUpWorkspaceDoc(workspaceId: string): Promise<WorkspaceDocCursor> {
  const docs = cacheBackedWorkspaceDocs()
  const cached = workspaceDocCache.get(workspaceDocCacheKey(workspaceId))
  if (cached === undefined) return docs.readCursor(workspaceId)
  // A COLD cursor, not the record's current one. Nothing tracks where the
  // cached document stands — it is mutated in place by every local write —
  // so the only honest answer is "I do not know", which is what
  // `{null, null}` says. `catchUp` reads that as a generation mismatch and
  // reconciles from the snapshot, which is the whole point: passing the
  // record's current cursor instead would say "already up to date" and
  // import nothing, leaving the caller with exactly the stale view it asked
  // to be rid of.
  const { cursor } = await docs.catchUp(workspaceId, cached, { generation: null, afterSeq: null })
  return cursor
}

/**
 * `WorkspaceDocs` over THIS module's live cache — every consumer that
 * operates on a workspace document through it (the tree index used by
 * delete/rename, the dual-plane index) shares the same instance the save
 * path diffs against, so no path can leave another holding a stale doc.
 */
export function cacheBackedWorkspaceDocs(): WorkspaceDocs {
  return {
    open: (workspaceId) => openWorkspaceDocIfStored(workspaceId),
    create: (workspaceId) => getWorkspaceDoc(workspaceId),
    save: (workspaceId, doc) => saveWorkspaceDoc(workspaceId, doc),
    // The tailing half is a STORE concern, so it delegates rather than being
    // reimplemented against the cache: the cursor describes the record, and
    // the only thing this wrapper adds is which doc gets caught up.
    readCursor: async (workspaceId) =>
      new DocumentStoreWorkspaceDocs(await documentStoreReady()).readCursor(workspaceId),
    // Under the workspace write barrier, because this MUTATES the live cached
    // document that every in-process writer is diffing against. Importing
    // another instance's ops into it while a local save is computing its own
    // delta is the one way a catch-up could make things worse rather than
    // better.
    catchUp: (workspaceId, doc, cursor) =>
      withWorkspaceWriteLock(workspaceId, async () =>
        new DocumentStoreWorkspaceDocs(await documentStoreReady()).catchUp(
          workspaceId,
          doc,
          cursor,
        ),
      ),
  }
}
