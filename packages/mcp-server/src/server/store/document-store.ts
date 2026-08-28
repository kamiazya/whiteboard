/**
 * The daemon's document store: a Loro snapshot per document, persisted
 * through the same `LibsqlDocumentStore` the MCP tool surface writes
 * (`document:<documentId>` rows), addressed through the workspace tree —
 * the tree is the whole address book (migration 0017 dropped the legacy
 * `documents` row-plane it used to fold in at startup). Everything the web
 * app shows and edits goes through here (ADR-0007's workspace/path store),
 * and reads/writes the SAME bytes a `wb_document_*` tool call would.
 *
 * `listDocuments` here is NOT `DocumentIndex`'s method of the same name —
 * that is the agent-facing side of the same split, reached
 * as `deps.documentIndex.*` and addressing documents by ULID rather than by
 * `(workspaceId, path)`. The names match because the concept does; the two
 * stores are what do not see each other. Both now write the same
 * `LibsqlDocumentStore` rows, which is why `saveDocument`/`compactDocument`
 * additionally take `withDocumentWriteLock` — see their comments.
 */
import { unlink } from 'node:fs/promises'
import {
  createWorkspaceDocumentAtPath,
  projectWorkspaceDocument,
  readDocumentKind,
  readWorkspaceDocuments,
  readWorkspaceMeta,
  readWorkspaceNodes,
  resolveWorkspaceDocument,
  resolveWorkspaceDocumentById,
  setWorkspaceLastCompactedAt,
  updateWorkspaceDocumentMeta,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { chunkSnapshot, DocumentPathTakenError } from '@kamiazya/whiteboard-ports'
import type { DocumentTeardown } from '@kamiazya/whiteboard-server-core'
import {
  DocumentStoreWorkspaceDocs,
  LoroWorkspaceDocumentIndex,
} from '@kamiazya/whiteboard-workspace-index'
import type { Frontiers } from 'loro-crdt'
import { decodeFrontiers, encodeFrontiers, LoroDoc, VersionVector } from 'loro-crdt'
import type { DocumentSummary } from '../../shared/api-contracts/document.js'
import { getDataDir } from '../config.js'
import { getLogger } from '../log.js'
import { validateDocumentPath, validateWorkspaceId } from '../validators.js'
import {
  corruptStoredData,
  isCorruptStoredDataError,
  isMissingFileError,
} from './corrupt-stored-data.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { upsertWorkspaceRow } from './db/upsert-workspace.js'
import { evictDoc, evictWorkspaceDocs, getOrLoad, peekDoc } from './doc-cache.js'
import { DocumentNotFoundError } from './document-not-found-error.js'
import { FsBlobStore } from './fs/fs-blob-store.js'
import { LibsqlDocumentStore } from './libsql/libsql-document-store.js'
import type { VersionStore } from './version-store.js'
import { thumbnailPath } from './version-store.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

// Chunk size shared with the MCP tool write path (server-core's
// document-io.ts) and migration 0011's FS-blob importer: an arbitrary
// value, but it must match across every writer of these rows so a snapshot
// chunked by one path reassembles identically when read by another.
const SNAPSHOT_MAX_CHUNK_BYTES = 1_000_000

// Give the error a stable name so callers, including MCP tools, can detect overwrite conflicts.
export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown error'
}

// Soft cap for snapshot size. Do not block saves when exceeded because preserving user
// data is more important; emit one warning per threshold breach and suggest compactDocument().

async function dbReady() {
  await prepareDataDir(getDataDir())
  return getDb(getDataDir())
}

// The MCP tool surface (server-core's ServerDeps) builds its own instance
// from the same one-db-per-dataDir Kysely handle, so both sides read/write
// the same `document:<documentId>` rows. The class is a stateless wrapper
// around that handle, so a fresh instance per call is equivalent.
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
 * delete/rename below does — and those paths drop the entry so the next
 * operation reopens the merged state.
 */
const workspaceDocCache = new Map<string, LoroDoc>()

function workspaceDocCacheKey(workspaceId: string): string {
  return `${getDataDir()}::${workspaceId}`
}

/**
 * The STORED workspace record's frontiers when the tree serves `path`, null
 * on the legacy plane. What a branch head stores for a tree-served document:
 * a projection's frontiers die with the process, the workspace record's
 * outlive it.
 */
/** The documentId at `path`, or null when the workspace tree does not serve it. */
export async function resolveDocumentIdAtPath(
  workspaceId: string,
  path: string,
): Promise<string | null> {
  const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
  if (workspaceDoc === null) return null
  const entry = resolveWorkspaceDocument(workspaceDoc, path)
  return entry === null ? null : entry.documentId
}

/** `resolveDocumentIdAtPath` that throws the routes' 404-mapped error instead of answering null. */
export async function requireDocumentAtPath(workspaceId: string, path: string): Promise<string> {
  const documentId = await resolveDocumentIdAtPath(workspaceId, path)
  if (documentId === null) throw new DocumentNotFoundError(workspaceId, path)
  return documentId
}

export async function workspaceFrontiersForPath(
  workspaceId: string,
  path: string,
): Promise<Uint8Array | null> {
  const docs = new DocumentStoreWorkspaceDocs(await documentStoreReady())
  const stored = await docs.open(workspaceId)
  if (stored === null || resolveWorkspaceDocument(stored, path) === null) return null
  return new Uint8Array(encodeFrontiers(stored.frontiers()))
}

/**
 * The document at `path` as it stood at `frontiers` of the WORKSPACE
 * document — null when the tree does not serve the path (legacy plane).
 * Throws when the frontiers cannot be checked out (a tip recorded against a
 * different lineage, e.g. a pre-cutover branch of a since-folded document —
 * that history was deliberately not carried by the fold).
 */
export async function projectDocumentAtWorkspaceFrontiers(
  workspaceId: string,
  path: string,
  frontiers: Frontiers,
): Promise<LoroDoc | null> {
  const docs = new DocumentStoreWorkspaceDocs(await documentStoreReady())
  const stored = await docs.open(workspaceId)
  if (stored === null) return null
  const entry = resolveWorkspaceDocument(stored, path)
  if (entry === null) return null
  const clone = LoroDoc.fromSnapshot(stored.export({ mode: 'snapshot' }))
  clone.checkout(frontiers)
  return projectWorkspaceDocument(clone, entry.documentId)
}

/**
 * A detached clone of the STORED workspace record, or null when none is
 * stored. What version/branch machinery forks and checks out: the stored
 * record's oplog is durable across restarts, where a projection's is
 * per-process.
 */
export async function cloneStoredWorkspaceDoc(workspaceId: string): Promise<LoroDoc | null> {
  const docs = new DocumentStoreWorkspaceDocs(await documentStoreReady())
  const stored = await docs
    .open(workspaceId)
    .catch((err) => throwWorkspaceRecordCorrupt(workspaceId, err))
  return stored === null ? null : LoroDoc.fromSnapshot(stored.export({ mode: 'snapshot' }))
}

// A workspace record whose stored bytes will not decode is CORRUPTION, and
// every reader should say so with the same structured error the per-document
// path uses — a raw wasm decode error surfaces as an unstructured 500.
function throwWorkspaceRecordCorrupt(workspaceId: string, err: unknown): never {
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
  if (update !== null) {
    for (const listener of workspaceDocUpdatedListeners) {
      try {
        listener(workspaceId, update)
      } catch (err) {
        // A subscriber failing to fan out must never turn a completed save
        // into a failed one.
        getLogger('document-store').warning(
          { workspaceId, err },
          'workspace-doc update listener threw; ignoring',
        )
      }
    }
  }
  return update
}

/**
 * `WorkspaceDocs` over THIS module's live cache — every consumer that
 * operates on a workspace document through it (the tree index used by
 * delete/rename, the dual-plane index) shares the same instance the save
 * path diffs against, so no path can leave another holding a stale doc.
 */
export function cacheBackedWorkspaceDocs(): {
  open(workspaceId: string): Promise<LoroDoc | null>
  create(workspaceId: string): Promise<LoroDoc>
  save(workspaceId: string, doc: LoroDoc): Promise<Uint8Array | null>
} {
  return {
    open: (workspaceId) => openWorkspaceDocIfStored(workspaceId),
    create: (workspaceId) => getWorkspaceDoc(workspaceId),
    save: (workspaceId, doc) => saveWorkspaceDoc(workspaceId, doc),
  }
}

/**
 * The workspaces REGISTRY, read from the daemon's `workspaces` table — the
 * one row-shaped truth the collapse kept (who this daemon keeps, not what
 * they contain). `saveWorkspaceDoc` upserts it, so a workspace exists here
 * exactly when a stored record does.
 */
export function workspaceRegistry(): { listWorkspaces(): Promise<{ workspaceId: string }[]> } {
  return {
    async listWorkspaces() {
      const db = await dbReady()
      const rows = await db.selectFrom('workspaces').select(['id']).execute()
      return rows.map((row) => ({ workspaceId: row.id }))
    },
  }
}

/**
 * The tree index, with this composition root's doc-cache kept coherent
 * around the moves and deletes the port performs. The cache is keyed by
 * (workspaceId, path); a move leaves every touched path holding a doc filed
 * under a name that no longer means what it did — the SOURCE half merely
 * stales, while the DESTINATION half corrupts: `getDoc` lazily creates an
 * empty doc for any path, so a read that arrived before the move left a
 * phantom cached there, and the next write through it would persist the
 * phantom over the moved document's real content. The shared index cannot
 * know this cache exists, so the composition root wraps it.
 */
export class CacheCoherentDocumentIndex extends LoroWorkspaceDocumentIndex {
  // Every mutator holds the workspace write lock, not only the two that
  // need cache eviction: the base class's own per-instance serialiser is a
  // DIFFERENT mutex from the one saveDocument/saveSnapshot hold, and two
  // disjoint mutexes over the same workspace record allow the lost-update
  // interleaving workspace-lock.ts's doc comment describes. Re-entrant, so
  // a caller already inside the lock (routes, teardown) is unaffected.
  override async createWorkspace(input: { workspaceId: string }): Promise<void> {
    return withWorkspaceWriteLock(input.workspaceId, () => super.createWorkspace(input))
  }

  override async createDocument(
    input: Parameters<LoroWorkspaceDocumentIndex['createDocument']>[0],
  ): ReturnType<LoroWorkspaceDocumentIndex['createDocument']> {
    return withWorkspaceWriteLock(input.workspaceId, () => super.createDocument(input))
  }

  override async setDocumentName(
    input: Parameters<LoroWorkspaceDocumentIndex['setDocumentName']>[0],
  ): Promise<void> {
    return withWorkspaceWriteLock(input.workspaceId, () => super.setDocumentName(input))
  }

  override async restoreDocument(
    input: Parameters<LoroWorkspaceDocumentIndex['restoreDocument']>[0],
  ): ReturnType<LoroWorkspaceDocumentIndex['restoreDocument']> {
    return withWorkspaceWriteLock(input.workspaceId, () => super.restoreDocument(input))
  }

  override async moveDocument(input: {
    workspaceId: string
    from: string
    to: string
  }): Promise<void> {
    // Under the workspace write lock, like the retired SQL index's move: the
    // route flows (WS updates, live-doc saves) load-and-save inside this
    // lock, so a move outside it can land between an update's stalled read
    // and its write — the update then lazily recreates the source path and a
    // phantom duplicate survives the rename.
    return withWorkspaceWriteLock(input.workspaceId, async () => {
      // Collected BEFORE the move: afterwards the tree is the only record of
      // the subtree, under its new paths.
      const workspaceDoc = await openWorkspaceDocIfStored(input.workspaceId)
      const movedPaths =
        workspaceDoc === null
          ? []
          : readWorkspaceNodes(workspaceDoc)
              .map((node) => node.path)
              .filter((path) => path === input.from || path.startsWith(`${input.from}/`))
      await super.moveDocument(input)
      for (const from of movedPaths) {
        evictDoc(input.workspaceId, from)
        evictDoc(
          input.workspaceId,
          from === input.from ? input.to : `${input.to}${from.slice(input.from.length)}`,
        )
      }
    })
  }

  override async deleteDocument(input: { workspaceId: string; path: string }): Promise<void> {
    return withWorkspaceWriteLock(input.workspaceId, async () => {
      await super.deleteDocument(input)
      evictDoc(input.workspaceId, input.path)
    })
  }
}

/** The tree index delete/rename go through, so a daemon delete evacuates the same way a port delete does. */
async function workspaceTreeIndex(): Promise<LoroWorkspaceDocumentIndex> {
  return new CacheCoherentDocumentIndex(
    cacheBackedWorkspaceDocs(),
    new FsBlobStore(getDataDir()),
    workspaceRegistry(),
  )
}

async function documentStoreReady(): Promise<LibsqlDocumentStore> {
  return new LibsqlDocumentStore(await dbReady())
}

// ── save LoroDoc by writing the snapshot binary to the blobs/ tree and
//    upserting the matching DB rows. ──
// overwrite defaults to false so canvas_create does not destroy existing
// data by mistake. Normal incremental saves (WS updates, live-doc and
// restore writes, compactDocument) must pass overwrite: true.
/**
 * Called after every successful `saveDocument`.
 *
 * A plain notification, not a compaction hook. This module used to name the
 * subscriber it happened to have — the auto-compact debouncer — which is how
 * the store came to know about compaction at all. It does not need to: what it
 * has to say is "this document changed", and who cares is not its business.
 *
 * A subscriber that throws is logged and swallowed. A save that already
 * succeeded must not be reported as failed because a listener misbehaved.
 */
export type DocumentSavedListener = (workspaceId: string, path: string) => void

let documentSavedListener: DocumentSavedListener | null = null

export function setDocumentSavedListener(listener: DocumentSavedListener | null): void {
  documentSavedListener = listener
}

function notifyDocumentSaved(workspaceId: string, path: string): void {
  if (documentSavedListener === null) return
  try {
    documentSavedListener(workspaceId, path)
  } catch (err) {
    getLogger('document-store').warning({ workspaceId, path, err }, 'document-saved listener threw')
  }
}

export async function saveDocument(
  workspaceId: string,
  path: string,
  doc: LoroDoc,
  options: { overwrite?: boolean; kind?: DocumentKind } = {},
): Promise<void> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  // Hold the workspace write barrier across the snapshot write + DB
  // upsert so a concurrent purgeDanglingFiles cannot observe a referenced
  // file as dangling: GC's collectReferencedFileIds() runs over the same
  // workspace blobs we are about to mutate, and chaining both behind the
  // workspace lock ensures it sees this save as either fully applied or
  // not yet started.
  return withWorkspaceWriteLock(workspaceId, async () => {
    const overwrite = options.overwrite ?? false
    const db = await dbReady()
    // The workspace REGISTRY row is still real (workspaceExists answers from
    // it); the documents rows are not written here anymore — the tree is the
    // whole record of what exists (S7).
    await upsertWorkspaceRow(db, workspaceId)
    const workspaceDoc = await getWorkspaceDoc(workspaceId)
    const existingEntry = resolveWorkspaceDocument(workspaceDoc, path)
    const existingDocumentId = existingEntry?.documentId ?? null
    if (existingDocumentId !== null && !overwrite) {
      throw new ConflictError(
        `Canvas "${workspaceId}/${path}" already exists. Pass { overwrite: true } to replace it.`,
      )
    }
    // A ULID, not a nanoid: the document index creates documents in this
    // same tree and the port's DocumentEntry accepts only a canonical ULID,
    // so a second minting policy here would keep producing documents the
    // agent surface has to skip. One tree, one id space.
    const documentId = existingDocumentId ?? generateDocumentId()
    // A save that names no kind and finds none on the tree or in the doc's
    // own bytes is a lazy-create of an empty document (the WS/update path on
    // an unknown path); the spatial editor is what opens those, so 'spatial'
    // is the honest default — not a guess about someone else's data.
    const kindForTree = options.kind ?? existingEntry?.kind ?? readDocumentKind(doc) ?? 'spatial'
    if (existingEntry === null) {
      createWorkspaceDocumentAtPath(workspaceDoc, { path, documentId, kind: kindForTree })
    } else if (options.kind !== undefined && existingEntry.kind !== options.kind) {
      // An explicit kind is an intentional sync request (e.g. restore
      // reconciling a different-kind source's content onto an existing
      // target); a plain re-save omits it and must never touch the value.
      updateWorkspaceDocumentMeta(workspaceDoc, documentId, { kind: options.kind })
    }
    // The create answers null when the tree already gave this path to a
    // DIFFERENT document — with no legacy plane to fall back to, writing
    // anywhere else would fork storage silently, so refuse loudly instead.
    if (!writeWorkspaceDocumentContent(workspaceDoc, documentId, doc)) {
      throw new ConflictError(
        `Path "${workspaceId}/${path}" is held by a different document in the workspace tree.`,
      )
    }
    await saveWorkspaceDoc(workspaceId, workspaceDoc)
    // A caller may hand this function a doc that is NOT the cached
    // projection (a fresh import, a checkout clone) — the cached one is then
    // behind the content just written, and the next getDoc would serve (and
    // a later save would diff) the stale copy. Self-heal at the funnel entry
    // instead of trusting every such caller to remember to evict.
    const cached = peekDoc(workspaceId, path)
    if (cached !== undefined && cached !== doc) evictDoc(workspaceId, path)
    notifyDocumentSaved(workspaceId, path)
  })
}

// ── load LoroDoc, returning an empty document when no snapshot exists ──
export async function loadDocument(workspaceId: string, path: string): Promise<LoroDoc> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  // The workspace tree answers first, and resolves the PATH itself (S6):
  // the tree is the address book now, so a document lists and serves even
  // if its mirror row is skewed or gone. The projection is a VALUE copy
  // with its own oplog.
  const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
  if (workspaceDoc === null) return new LoroDoc()
  const entry = resolveWorkspaceDocument(workspaceDoc, path)
  if (entry === null) return new LoroDoc()
  const projected = projectWorkspaceDocument(workspaceDoc, entry.documentId)
  return projected ?? new LoroDoc()
}

/**
 * `loadDocument` through the resident LRU (doc-cache.ts), which is what most
 * callers want: a WS frame, an export, and a version read of the same
 * document within a session should share one LoroDoc rather than each
 * rebuilding several MiB of CRDT history. Reach for `loadDocument` directly
 * only when a *fresh* instance is the point.
 */
export async function getDoc(workspaceId: string, path: string): Promise<LoroDoc> {
  // No staleness refresh: every served document is a tree projection that
  // each write path mutates in place (saveDocument diffs against the live
  // workspace doc), so a cache hit IS the current state. The legacy
  // per-document delta replay that used to run here died with the legacy
  // plane — replaying that other oplog into a projection resurrected
  // pre-fold state over current content.
  return getOrLoad(workspaceId, path, () => loadDocument(workspaceId, path))
}

/**
 * Whether this daemon has ever registered the workspace.
 *
 * Exists so read surfaces can tell "empty" from "never heard of it". Nothing
 * mints workspace ids ahead of use any more, but ids OUTLIVE the daemon that
 * minted them — a browser keeps its paired workspace id in localStorage, and
 * a rebuilt data dir does not know it. Answering such an id with empty lists
 * and lazily-created empty docs reads exactly like the user's data being
 * gone, when the truth is "not here".
 */
export async function workspaceExists(workspaceId: string): Promise<boolean> {
  validateWorkspaceId(workspaceId)
  const db = await dbReady()
  const row = await db
    .selectFrom('workspaces')
    .select(['id'])
    .where('id', '=', workspaceId)
    .executeTakeFirst()
  return row !== undefined
}

export async function documentExists(workspaceId: string, path: string): Promise<boolean> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  return (await resolveDocumentIdAtPath(workspaceId, path)) !== null
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }
}

// ── delete a canvas and every file it owns ──
// Returns false (never throws) for a missing canvas so callers can treat
// "already gone" and "just deleted" the same way an idempotent DELETE
// should.
//
// Order matters for the crash-safety story: the DB row goes first, so a
// crash between the row delete and the thumbnail unlinks below leaves
// orphan thumbnail files (invisible — nothing lists the deleted documentId
// anymore) rather than the reverse — a listed canvas whose content is
// already gone.
// ponytail: orphaned files from that crash window are not swept by
// file-gc (its collectReferencedFileIds targets uploaded images, not these
// version thumbnails); revisit if orphan blobs start showing up in the
// storage report.
/**
 * Everything about a document that is neither Libsql bytes nor a workspace
 * tree node: one thumbnail per version, and the cached doc instance.
 * server-core cannot name any of it, so it reaches this through
 * `ServerDeps.documentTeardown` — which is what makes `wb_document_delete`
 * clean up the way the HTTP DELETE does instead of leaving stale files and a
 * stale cache entry behind.
 *
 * Two phases because a thumbnail is filed under a VERSION id, and the
 * versions rows are deleted right after the document goes (explicitly,
 * since 0016 dropped the cascade FK): the ids have to be captured while
 * the document is still whole. The row delete and the two sweeps are
 * separate statements, not one transaction — a crash between them leaves
 * orphaned versions/branches rows.
 * ponytail: acceptable while nothing lists rows by dangling documentId;
 * a boot-time orphan sweep is the upgrade path if they ever show up.
 */
export const documentTeardown: DocumentTeardown = {
  around({ workspaceId, documentId, path }, deleteDocument) {
    // The whole delete runs under this workspace's write barrier, capture
    // included. A version saved between the capture and the row delete
    // would otherwise have its row cascaded away while its thumbnail was
    // never in the captured set — an orphaned file, from the one seam that
    // exists to prevent them.
    return withWorkspaceWriteLock(workspaceId, async () => {
      const db = await dbReady()
      const versionRows = await db
        .selectFrom('versions')
        .select(['id'])
        .where('documentId', '=', documentId)
        .execute()

      const result = await deleteDocument()

      // Version/branch rows no longer cascade from a documents row
      // (migration 0016 dropped the FK — a tree-only document has no row to
      // cascade from), so delete-completeness for every delete path that
      // runs through this bracket lives here.
      await db.deleteFrom('versions').where('documentId', '=', documentId).execute()
      await db.deleteFrom('branches').where('documentId', '=', documentId).execute()

      for (const { id: versionId } of versionRows) {
        await unlinkIfExists(thumbnailPath(workspaceId, versionId))
      }

      // Force the next getDoc() to reload from disk (there is nothing left to
      // reload from — a fresh create should not inherit a doc instance that
      // still holds the deleted canvas's history).
      evictDoc(workspaceId, path)

      return result
    })
  },
}

export async function deleteDocument(workspaceId: string, path: string): Promise<boolean> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  const documentId = await resolveDocumentIdAtPath(workspaceId, path)
  if (documentId === null) return false

  // The same bracket wb_document_delete runs in (server-core's
  // document-crud.ts) — deliberately, because the two used to be separate
  // implementations and only one of them cleaned up. The bracket takes the
  // workspace write lock, captures thumbnail ids while the document is
  // whole, and deletes versions/branches rows after (migration 0016 dropped
  // the cascade).
  return documentTeardown.around({ workspaceId, documentId, path }, async () => {
    // The tree node goes through the index's delete, which EVACUATES the
    // content into the trash before removing anything — the daemon's delete
    // keeps the same recoverability promise the agent-facing port makes.
    // `documentId` came from the tree above, so the node is guaranteed to
    // still be there unless a concurrent delete already removed it.
    const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
    if (workspaceDoc !== null && resolveWorkspaceDocumentById(workspaceDoc, documentId) !== null) {
      // Cache-backed, so the index deletes on the same live instance every
      // other path writes through.
      const index = await workspaceTreeIndex()
      await index.deleteDocument({ workspaceId, path })
    }

    // The identity goes first, then the Libsql snapshot/delta/frontier
    // rows, so a crash between the two leaves an orphaned-but-unreachable
    // snapshot rather than a listed canvas with no content.
    const documentStore = await documentStoreReady()
    await documentStore.deleteDoc({ docRef: { kind: 'document', workspaceId, documentId } })

    return true
  })
}

// Null for both "no such canvas" and "the canvas records no kind" — its
// callers want the same thing from either, which is to stamp nothing.
//
// This deliberately does NOT resolve an unset kind to 'spatial' the way
// listDocuments does. The difference is what the answer is used for: a list
// renders a badge, while this feeds a WRITE onto a restored canvas's row.
// A guess that gets stored outlives the guess — a markdown document that
// predates kinds would become permanently spatial and open in the wrong
// editor, which is the exact failure the callers' comments say they are
// copying the source's kind to avoid.
export async function getDocumentKind(
  workspaceId: string,
  path: string,
): Promise<DocumentKind | null> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
  if (workspaceDoc === null) return null
  return resolveWorkspaceDocument(workspaceDoc, path)?.kind ?? null
}

export interface CompactResult {
  compacted: boolean
  beforeBytes: number
  afterBytes: number
  reason?: 'no-versions' | 'no-file' | 'no-gain' | 'ok'
}

/**
 * Compacts the WORKSPACE record: a shallow snapshot cut at the earliest
 * frontiers any workspace-scoped version still needs, superseding the delta
 * log it folded. The per-document address survives in the signature because
 * the routes and the auto-compact debouncer speak per document, but since
 * every document now lives in the one workspace record, they all compact the
 * same thing — a second call right after answers 'no-gain'.
 *
 * Risk parity with the retired per-document compaction, not an improvement
 * on it: the cut considers version rows only, so a branch head recorded
 * before the workspace's earliest version can lose the history its checkout
 * needs, exactly as the old design could per document.
 */
/**
 * The earliest history any reader still needs: the pointwise-minimum version
 * vector across the earliest version row and every branch tip recorded for
 * the workspace, converted back to a frontiers cut. A peer absent from any
 * pin's vector means that pin includes none of the peer's ops, so the
 * minimum excludes the peer entirely — the cut only ever moves BACKWARD
 * from the version-only cut, never forward.
 */
async function retainedHistoryCut(
  workspaceId: string,
  doc: LoroDoc,
  earliestVersion: Frontiers,
): Promise<Frontiers> {
  const db = await dbReady()
  const rows = await db
    .selectFrom('branches')
    .select(['tipFrontiers', 'name', 'documentId'])
    .where('workspaceId', '=', workspaceId)
    .execute()
  const pins: { frontiers: Frontiers; branch: string }[] = []
  for (const row of rows) {
    // An empty tip is a branch nothing has written to yet — it pins nothing.
    if (row.tipFrontiers.length === 0) continue
    try {
      pins.push({
        frontiers: decodeFrontiers(new Uint8Array(Buffer.from(row.tipFrontiers, 'base64'))),
        branch: `${row.documentId}#${row.name}`,
      })
    } catch (error) {
      throw corruptStoredData(
        `${workspaceId}/branches/${row.documentId}#${row.name}`,
        `tipFrontiers could not be decoded (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }
  if (pins.length === 0) return earliestVersion
  const vvs = [doc.frontiersToVV(earliestVersion).toJSON()]
  for (const pin of pins) {
    try {
      vvs.push(doc.frontiersToVV(pin.frontiers).toJSON())
    } catch {
      // A frontier the workspace record's oplog does not contain: a branch
      // tip captured on the retired per-document plane, whose ops the boot
      // fold copied by VALUE rather than importing. Such a branch cannot be
      // checked out on the workspace record no matter what the cut keeps, so
      // it pins nothing — and it must not disable compaction for the whole
      // workspace by throwing here.
      getLogger('document-store').warning(
        { workspaceId, branch: pin.branch },
        'branch tip frontier is foreign to the workspace record; not pinning history',
      )
    }
  }
  if (vvs.length === 1) return earliestVersion
  const min = new Map(vvs[0])
  for (const vv of vvs.slice(1)) {
    for (const [peer, counter] of [...min]) {
      const other = vv.get(peer)
      if (other === undefined) min.delete(peer)
      else if (other < counter) min.set(peer, other)
    }
  }
  return doc.vvToFrontiers(VersionVector.parseJSON(min))
}

export async function compactDocument(
  workspaceId: string,
  path: string,
  versionStore: VersionStore,
): Promise<CompactResult> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  const _db = await dbReady()
  const documentId = await resolveDocumentIdAtPath(workspaceId, path)
  if (documentId === null) {
    return { compacted: false, beforeBytes: 0, afterBytes: 0, reason: 'no-file' }
  }
  const documentStore = await documentStoreReady()
  const docRef = { kind: 'workspace-tree' as const, workspaceId }

  // The workspace lock is what every workspace-record writer holds, so the
  // read that decides the shallow snapshot and the write that persists it
  // see no concurrent tree write in between.
  return withWorkspaceWriteLock(workspaceId, async () => {
    const manifest = await documentStore.readSnapshotManifest({ docRef })
    if (manifest === null) {
      return { compacted: false, beforeBytes: 0, afterBytes: 0, reason: 'no-file' }
    }
    const { updates: storedDeltas } = await documentStore.loadDeltas({
      docRef,
      sinceFrontier: new Uint8Array(),
    })
    const beforeBytes =
      manifest.totalBytes + storedDeltas.reduce((sum, delta) => sum + delta.byteLength, 0)

    const earliestVersion = await versionStore.earliestWorkspaceFrontiers(workspaceId)
    if (!earliestVersion) {
      return { compacted: false, beforeBytes, afterBytes: beforeBytes, reason: 'no-versions' }
    }

    // The live cached workspace document IS the current state — every write
    // path mutates it under the lock held here — so the fold exports from
    // it instead of re-reading stored bytes.
    const doc = await getWorkspaceDoc(workspaceId)

    // Branch tips pin history exactly like version rows do: Loro refuses a
    // checkout before the shallow start, so a cut past a branch tip breaks
    // that branch's switch, merge and file-gc scan. The cut is held back to
    // the pointwise-minimum version vector across the earliest version and
    // every recorded branch tip — strictly conservative, and the version
    // requirement stays: no version row still means no compaction at all.
    const cut = await retainedHistoryCut(workspaceId, doc, earliestVersion)
    const shallow = doc.export({ mode: 'shallow-snapshot', frontiers: cut })
    if (shallow.byteLength >= beforeBytes) {
      return { compacted: false, beforeBytes, afterBytes: beforeBytes, reason: 'no-gain' }
    }
    const { manifest: fresh, chunks } = chunkSnapshot(
      new Uint8Array(shallow),
      SNAPSHOT_MAX_CHUNK_BYTES,
    )
    await documentStore.saveCompactedSnapshot({
      docRef,
      manifest: fresh,
      chunks,
      frontier: new Uint8Array(doc.oplogVersion().encode()),
      // Exactly the log this fold consumed. Anything appended since the read
      // above is neither in `shallow` nor superseded by it, and dropping it
      // would lose an edit that arrived while compaction ran.
      supersededDeltaCount: storedDeltas.length,
    })
    // Compaction folds the WORKSPACE record's oplog, so the timestamp the
    // storage report shows describes the workspace, on the workspace meta.
    // Written after the compacted snapshot, as a small delta on top of it.
    setWorkspaceLastCompactedAt(doc, Date.now())
    await saveWorkspaceDoc(workspaceId, doc)
    // No eviction: the live workspace document keeps its full in-memory
    // history and the frontier just written is its own current one, so both
    // it and the projections served from it stay coherent with the store.
    return { compacted: true, beforeBytes, afterBytes: shallow.byteLength, reason: 'ok' }
  })
}

// ── most-recent auto-compact timestamp across all documents ───────────
// Used by the storage report to show "Auto-optimised Ns ago" without
// client-side aggregation. Returns null when no canvas has been compacted yet.
export async function readLatestCompactedAt(): Promise<number | null> {
  const db = await dbReady()
  const workspaces = await db.selectFrom('workspaces').select(['id']).execute()
  let latest: number | null = null
  for (const { id } of workspaces) {
    const workspaceDoc = await openWorkspaceDocIfStored(id)
    if (workspaceDoc === null) continue
    const at = readWorkspaceMeta(workspaceDoc).lastCompactedAt
    if (at !== undefined && (latest === null || at > latest)) latest = at
  }
  return latest
}

// ── list workspaces from the workspaces table ──
export async function listWorkspaces(): Promise<{ workspaceId: string }[]> {
  const db = await dbReady()
  const rows = await db.selectFrom('workspaces').select(['id', 'updatedAt']).execute()
  return rows.map((r) => ({ workspaceId: r.id }))
}

// ── rename a document's path ──
// A tree move: the node is re-parented and descendants ride along for free.
// Returns null (never throws) for a missing source, matching
// deleteDocument's boolean-shaped "already gone" handling; a rename onto an
// already-taken path throws ConflictError, the error the routes map.
export async function renameDocumentPath(
  workspaceId: string,
  oldPath: string,
  newPath: string,
): Promise<{ documentId: string } | null> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(oldPath)
  validateDocumentPath(newPath)
  return withWorkspaceWriteLock(workspaceId, async () => {
    const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
    const entry = workspaceDoc === null ? null : resolveWorkspaceDocument(workspaceDoc, oldPath)
    // A path only the rows know is a pre-fold legacy document; renaming one
    // before the boot fold has absorbed it is not a supported operation —
    // the fold will place it, and the rename can happen after.
    if (entry === null) return null
    const documentId = entry.documentId
    if (oldPath === newPath) return { documentId }

    // The paths whose cache keys this move invalidates, collected BEFORE
    // the move because the tree is the only record of the subtree.
    const movedPaths =
      workspaceDoc === null
        ? []
        : readWorkspaceNodes(workspaceDoc)
            .map((node) => node.path)
            .filter((path) => path === oldPath || path.startsWith(`${oldPath}/`))

    // The index's move owns the collision rules (occupied destination,
    // move-into-self, folder promotion) — one definition, not a second
    // rows-shaped copy of it.
    const index = await workspaceTreeIndex()
    try {
      await index.moveDocument({ workspaceId, from: oldPath, to: newPath })
    } catch (err) {
      if (err instanceof DocumentPathTakenError) {
        throw new ConflictError(`Canvas "${workspaceId}/${err.path}" already exists`)
      }
      throw err
    }

    // Force the next getDoc() to reload under every key the move touched.
    // A source path: a caller still reading through it should lazily create
    // a fresh canvas rather than resurrect the moved doc's cached instance.
    // A destination path: a WS connect or update-route call against it
    // before this move can lazily cache an empty phantom doc there — leaving
    // that phantom cached would shadow the just-moved canvas's real content.
    for (const from of movedPaths) {
      evictDoc(workspaceId, from)
      evictDoc(workspaceId, from === oldPath ? newPath : `${newPath}${from.slice(oldPath.length)}`)
    }
    return { documentId }
  })
}

// ── list documents from the workspace record ──
export async function listDocuments(
  workspaceId: string,
): Promise<Pick<DocumentSummary, 'path' | 'id' | 'displayName' | 'updatedAt' | 'kind'>[]> {
  validateWorkspaceId(workspaceId)
  const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
  if (workspaceDoc === null) return []
  return readWorkspaceDocuments(workspaceDoc).map((entry) => ({
    path: entry.path,
    id: entry.documentId,
    // Absent rather than null when unset: a document nobody renamed has no
    // name of its own to report.
    ...(entry.name === undefined ? {} : { displayName: entry.name }),
    // Every tree write stamps updatedAt (S4b) and the fold carries the row
    // value; a record written between the cutover and S4b simply has none,
    // and the epoch is the honest "unknown" for our own pre-release data.
    updatedAt: new Date(entry.updatedAt ?? entry.createdAt ?? 0).toISOString(),
    kind: entry.kind,
  }))
}
