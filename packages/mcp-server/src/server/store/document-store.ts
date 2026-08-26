/**
 * The daemon's document store: a Loro snapshot per document, persisted
 * through the same `LibsqlDocumentStore` the MCP tool surface writes
 * (`document:<documentId>` rows), plus the `documents` row that gives it a
 * workspace and a path. Everything the web app shows and edits goes through
 * here (ADR-0007's workspace/path store), and now reads/writes the SAME
 * bytes a `wb_document_*` tool call would — the FS `.loro` blob tree
 * `documentBlobPath` still computes is no longer read or written here; it
 * survives only as an identity label for corrupt-data error messages and as
 * the legacy-migration backup path. Any blob file still on disk is swept
 * away by `sweep-imported-fs-blobs.ts` once its bytes are proven to live in
 * Libsql, so `deleteDocument`'s unlink below is a straggler cleanup, not the
 * primary deletion path.
 *
 * `listDocuments`/`deleteDocument` here are NOT `DocumentIndex`'s methods of
 * the same names — that is the agent-facing side of the same split, reached
 * as `deps.documentIndex.*` and addressing documents by ULID rather than by
 * `(workspaceId, path)`. The names match because the concept does; the two
 * stores are what do not see each other. Both now write the same
 * `LibsqlDocumentStore` rows, which is why `saveDocument`/`compactDocument`
 * additionally take `withDocumentWriteLock` — see their comments.
 */
import { access, mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  createWorkspaceDocumentAtPath,
  moveWorkspaceNodeToPath,
  projectWorkspaceDocument,
  readDocumentKind,
  resolveWorkspaceDocumentById,
  setWorkspaceLastCompactedAt,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { documentKindSchema, generateDocumentId } from '@kamiazya/whiteboard-model'
import {
  chunkSnapshot,
  DocumentMoveIntoSelfError,
  isSelfOrDescendant,
  planSubtreeMove,
  reassembleSnapshot,
} from '@kamiazya/whiteboard-ports'
import type { DocumentTeardown } from '@kamiazya/whiteboard-server-core'
import {
  DocumentStoreWorkspaceDocs,
  LoroWorkspaceDocumentIndex,
} from '@kamiazya/whiteboard-workspace-index'
import type { Frontiers, Value } from 'loro-crdt'
import { encodeFrontiers, LoroDoc, LoroMap, VersionVector } from 'loro-crdt'
import type { DocumentSummary } from '../../shared/api-contracts/document.js'
import { getDataDir } from '../config.js'
import { getLogger } from '../log.js'
import { validateDocumentId, validateDocumentPath, validateWorkspaceId } from '../validators.js'
import {
  corruptStoredData,
  isCorruptStoredDataError,
  isMissingFileError,
} from './corrupt-stored-data.js'
import { deleteDocumentRow } from './db/delete-document-row.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { getDocumentIdByPath, upsertWorkspaceRow } from './db/upsert-workspace.js'
import { evictDoc, evictWorkspaceDocs, getOrLoad, peekDoc } from './doc-cache.js'
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

// ── blob path helpers ──
// Legacy snapshots live under {dataDir}/blobs/{workspaceId}/canvas/{documentId}.loro.
// The documentId is the stable row PK from the `documents` table, so renaming
// a document's path does not move blobs around.
//
// The `canvas/` segment names the CONTAINER, which ADR-0009 calls a Document,
// and it deliberately stays: this tree is being RETIRED, not corrected.
// `0011-import-fs-blobs` reads it as a frozen literal and
// `sweep-imported-fs-blobs.ts` deletes each file — then the directory — once
// its bytes are proven to live in Libsql. A migration that renamed the
// segment would move every legacy blob out from under that sweep, leaving it
// neither verified nor cleaned up. There is nothing here to rename once the
// last file is gone.
function blobsRoot(): string {
  return join(getDataDir(), 'blobs')
}

function documentBlobPath(workspaceId: string, documentId: string): string {
  validateWorkspaceId(workspaceId)
  validateDocumentId(documentId)
  return join(blobsRoot(), workspaceId, 'canvas', `${documentId}.loro`)
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
export async function workspaceFrontiersForPath(
  workspaceId: string,
  path: string,
): Promise<Uint8Array | null> {
  const db = await dbReady()
  const documentId = await getDocumentIdByPath(db, workspaceId, path)
  if (!documentId) return null
  const docs = new DocumentStoreWorkspaceDocs(await documentStoreReady())
  const stored = await docs.open(workspaceId)
  if (stored === null || resolveWorkspaceDocumentById(stored, documentId) === null) return null
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
  const db = await dbReady()
  const documentId = await getDocumentIdByPath(db, workspaceId, path)
  if (!documentId) return null
  const docs = new DocumentStoreWorkspaceDocs(await documentStoreReady())
  const stored = await docs.open(workspaceId)
  if (stored === null || resolveWorkspaceDocumentById(stored, documentId) === null) return null
  const clone = LoroDoc.fromSnapshot(stored.export({ mode: 'snapshot' }))
  clone.checkout(frontiers)
  return projectWorkspaceDocument(clone, documentId)
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
 * The documents `loadDocument` served from the workspace tree. `getDoc`'s
 * cache-refresh must NOT replay legacy per-document deltas into these: a
 * projection has its own fresh oplog, and importing the old lineage's ops
 * on top of it resurrects pre-fold state over current content.
 */
const treeServedDocs = new WeakSet<LoroDoc>()

/** The tree index delete/rename go through, so a daemon delete evacuates the same way a port delete does. */
async function workspaceTreeIndex(): Promise<LoroWorkspaceDocumentIndex> {
  return new LoroWorkspaceDocumentIndex(cacheBackedWorkspaceDocs(), new FsBlobStore(getDataDir()))
}

async function documentStoreReady(): Promise<LibsqlDocumentStore> {
  return new LibsqlDocumentStore(await dbReady())
}

// Merge-then-save for the live-doc path. The lock alone only makes an
// overwrite ATOMIC — it cannot make it correct: `doc` may be a long-lived
// cached instance (doc-cache) that has not seen ops an MCP tool wrote to
// these same rows since it loaded, and exporting it as the whole new truth
// would erase them in one clean write. When the stored frontier is not
// already contained in the doc's version (behind or concurrent), import
// the stored snapshot first so the save is a CRDT merge — ops the doc
// already carries are no-ops, unseen ops join the history (and, for a
// cached doc, heal the live session in place). The frontier check is the
// fast path: one small row read skips the full snapshot load whenever this
// doc was the last writer. A stored snapshot that fails to import falls
// back to plain overwrite — the pre-flip semantics for an unreadable
// snapshot — with a warning.
/**
 * Brings `doc` up to the stored bytes when it is behind them, and does
 * nothing when it is not.
 *
 * Used on BOTH sides, and for the same reason from opposite directions: a
 * writer must not overwrite work it never saw, and a reader must not serve
 * a cached document someone else has since written past. The read side is
 * what makes the resident LRU self-correcting — every write would otherwise
 * have to remember to evict, and the MCP tools cannot: they address
 * documents by id and have no idea what path a document is cached under.
 *
 * Throws rather than logging, so each caller can say what its own failure
 * costs — an overwrite on the write side, stale bytes on the read side.
 */
async function importStoredIfBehind(
  documentStore: LibsqlDocumentStore,
  workspaceId: string,
  documentId: string,
  doc: LoroDoc,
): Promise<void> {
  const docRef = { kind: 'document' as const, workspaceId, documentId }
  const stored = await documentStore.readFrontier({ docRef })
  if (stored === null) return
  const comparison = doc.oplogVersion().compare(VersionVector.decode(stored.frontier))
  // `undefined` means the two histories diverged — neither is a prefix of the
  // other — which is still a reason to merge, not to ignore.
  if (comparison !== undefined && comparison >= 0) return
  const existing = await documentStore.loadSnapshot({ docRef })
  if (existing !== null) doc.import(reassembleSnapshot(existing.manifest, existing.chunks))
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
    const existingDocumentId = await getDocumentIdByPath(db, workspaceId, path)
    if (existingDocumentId && !overwrite) {
      throw new ConflictError(
        `Canvas "${workspaceId}/${path}" already exists. Pass { overwrite: true } to replace it.`,
      )
    }
    // Pre-allocate the documentId for new documents so the snapshot can be
    // written before any metadata row commits. If the snapshot write fails
    // (driver error, transient corruption) we leave no DB row behind, so a
    // retry can succeed instead of hitting a phantom ConflictError on the
    // orphan.
    // A ULID, not a nanoid: the document index creates rows in this same
    // table and the port's DocumentEntry accepts only a canonical ULID, so a
    // second minting policy here would keep producing rows the agent surface
    // has to skip. One table, one id space.
    const documentId = existingDocumentId ?? generateDocumentId()
    const _documentStore = await documentStoreReady()
    // Which plane this document persists on. A save with a KNOWN kind lands
    // on the workspace tree (the node's containers are the content record);
    // a kindless save of a document the tree does not hold stays on the
    // legacy per-document plane — recording it in the tree would mean
    // inventing the format, the same guess the startup fold refuses.
    let existingKind: DocumentKind | null = null
    if (existingDocumentId !== undefined && existingDocumentId !== null) {
      const row = await db
        .selectFrom('documents')
        .select(['kind'])
        .where('id', '=', documentId)
        .executeTakeFirst()
      const parsed = documentKindSchema.safeParse(row?.kind)
      existingKind = parsed.success ? parsed.data : null
    }
    // Every save lands on the workspace tree. A save that names no kind and
    // finds none stored or in the doc's own bytes is a lazy-create of an
    // empty document (the WS/update path on a path with no row); the spatial
    // editor is what opens those, so 'spatial' is the honest default — not a
    // guess about someone else's data, because pre-kind rows no longer exist
    // (the startup fold deletes them as this project's own data defect).
    const kindForTree = options.kind ?? existingKind ?? readDocumentKind(doc) ?? 'spatial'
    const workspaceDoc = await getWorkspaceDoc(workspaceId)
    if (resolveWorkspaceDocumentById(workspaceDoc, documentId) === null) {
      createWorkspaceDocumentAtPath(workspaceDoc, { path, documentId, kind: kindForTree })
    }
    // The create answers null when the tree already gave this path to a
    // DIFFERENT document — a rows/tree divergence. With no legacy plane to
    // fall back to, writing anywhere else would fork storage silently, so
    // refuse loudly instead.
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
    await upsertWorkspaceRow(db, workspaceId)
    if (existingDocumentId) {
      // A plain re-save (WS updates, live-doc writes, compactDocument) omits
      // `kind` and must never touch the stored value. An explicit `kind` is
      // an intentional sync request (e.g. restore reconciling a different-
      // kind source's content onto an existing target) and is honored.
      await db
        .updateTable('documents')
        .set({
          updatedAt: Date.now(),
          ...(options.kind !== undefined ? { kind: options.kind } : {}),
        })
        .where('id', '=', documentId)
        .execute()
    } else {
      const now = Date.now()
      await db
        .insertInto('documents')
        .values({
          id: documentId,
          workspaceId,
          path,
          displayName: null,
          isPinned: 0,
          pinOrder: null,
          currentBranch: 'main',
          createdAt: now,
          updatedAt: now,
          // Written on insert, always matching what the tree just recorded.
          // The update branch above honors an explicit `kind` too (a plain
          // re-save omits it and leaves the stored value untouched); the
          // onConflict branch below is the rare insert-raced-with-a-
          // concurrent-insert fallback and, like a plain re-save, does not
          // touch `kind`.
          kind: kindForTree,
        })
        .onConflict((oc) => oc.columns(['workspaceId', 'path']).doUpdateSet({ updatedAt: now }))
        .execute()
    }
    notifyDocumentSaved(workspaceId, path)
  })
}

// ── load LoroDoc, returning an empty document when no snapshot exists ──
export async function loadDocument(workspaceId: string, path: string): Promise<LoroDoc> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  const db = await dbReady()
  const documentId = await getDocumentIdByPath(db, workspaceId, path)
  if (!documentId) return new LoroDoc()
  // The workspace tree answers first: that is where a kind-carrying save
  // persists. The projection is a VALUE copy with its own oplog — see
  // treeServedDocs for why the legacy delta log must never replay into it.
  const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
  if (workspaceDoc !== null) {
    const projected = projectWorkspaceDocument(workspaceDoc, documentId)
    if (projected !== null) {
      treeServedDocs.add(projected)
      return projected
    }
  }
  // Purely a stable identity label for corrupt-data error messages and the
  // legacy-migration backup file below — no longer an FS path this function
  // reads from.
  const blobPath = documentBlobPath(workspaceId, documentId)
  const documentStore = await documentStoreReady()
  let doc: LoroDoc
  let originalBytes: Uint8Array
  try {
    const snapshot = await documentStore.loadSnapshot({
      docRef: { kind: 'document', workspaceId, documentId },
    })
    if (snapshot === null) return new LoroDoc()
    try {
      originalBytes = reassembleSnapshot(snapshot.manifest, snapshot.chunks)
    } catch (error) {
      throw corruptStoredData(blobPath, `invalid canvas snapshot chunks (${errorMessage(error)})`, {
        locationKind: 'identity',
      })
    }
    try {
      doc = LoroDoc.fromSnapshot(originalBytes)
    } catch (error) {
      throw corruptStoredData(blobPath, `invalid canvas snapshot (${errorMessage(error)})`, {
        locationKind: 'identity',
      })
    }
    // The snapshot is the BASE, not the document. Since saves append rather
    // than rewrite, everything written since the last fold is in the log, and
    // a read that stopped at the snapshot would serve a document missing its
    // most recent edits — the newest ones, which is the worst half to lose.
    const { updates } = await documentStore.loadDeltas({
      docRef: { kind: 'document', workspaceId, documentId },
      sinceFrontier: new Uint8Array(),
    })
    for (const update of updates) {
      try {
        doc.import(update)
      } catch (error) {
        throw corruptStoredData(blobPath, `invalid canvas delta (${errorMessage(error)})`, {
          locationKind: 'identity',
        })
      }
    }
  } catch (error) {
    if (isCorruptStoredDataError(error)) {
      throw error
    }
    throw corruptStoredData(blobPath, `failed to read canvas snapshot (${errorMessage(error)})`, {
      locationKind: 'identity',
    })
  }
  // One-shot legacy container migration. Older data stored "elements" in
  // LoroList; current code uses LoroMovableList. Repair on load and rewrite.
  const migrated = migrateLegacyListToMovable(doc)
  if (migrated) {
    try {
      const bakPath = `${blobPath}.pre-migrate-bak`
      const bakExists = await access(bakPath)
        .then(() => true)
        .catch(() => false)
      if (!bakExists) {
        await mkdir(dirname(bakPath), { recursive: true })
        await writeFile(bakPath, originalBytes)
      }
      await saveDocument(workspaceId, path, doc, { overwrite: true })
    } catch (err) {
      getLogger('document-store').warning(
        { workspaceId, path, err: err as Error },
        'legacy list→movable migration persist failed',
      )
    }
  }
  return doc
}

/**
 * `loadDocument` through the resident LRU (doc-cache.ts), which is what most
 * callers want: a WS frame, an export, and a version read of the same
 * document within a session should share one LoroDoc rather than each
 * rebuilding several MiB of CRDT history. Reach for `loadDocument` directly
 * only when a *fresh* instance is the point.
 */
export async function getDoc(workspaceId: string, path: string): Promise<LoroDoc> {
  // Only a HIT can be stale; a miss is about to load the stored bytes anyway.
  // Paying the two small indexed reads here rather than on every call keeps
  // the common path unchanged.
  const cached = peekDoc(workspaceId, path)
  if (cached !== undefined) {
    try {
      // A tree-served projection is refreshed by every write flowing through
      // it (saveDocument diffs against the live workspace doc), and the
      // legacy delta log belongs to a DIFFERENT oplog — importing it here
      // would resurrect pre-fold state over current content.
      if (!treeServedDocs.has(cached)) {
        const db = await dbReady()
        const documentId = await getDocumentIdByPath(db, workspaceId, path)
        if (documentId) {
          await importStoredIfBehind(await documentStoreReady(), workspaceId, documentId, cached)
        }
      }
    } catch (err) {
      // Serving the cached document is the honest fallback: it is what this
      // process last knew, and refusing to answer would turn a stale read
      // into a failed one.
      getLogger('document').warning(
        { workspaceId, path, err: err as Error },
        'could not refresh cached document from the store; serving cached bytes',
      )
    }
  }
  return getOrLoad(workspaceId, path, () => loadDocument(workspaceId, path))
}

function migrateLegacyListToMovable(doc: LoroDoc): boolean {
  const list = doc.getList('elements')
  const movable = doc.getMovableList('elements')
  if (list.length === 0) return false
  if (movable.length > 0) return false
  for (let i = 0; i < list.length; i++) {
    const item = list.get(i)
    if (!(item instanceof LoroMap)) continue
    const json = item.toJSON() as Record<string, unknown>
    const dst = movable.insertContainer(movable.length, new LoroMap())
    for (const [k, v] of Object.entries(json)) {
      if (v !== undefined) dst.set(k, v as Value)
    }
  }
  list.delete(0, list.length)
  doc.commit()
  return true
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
  const db = await dbReady()
  const documentId = await getDocumentIdByPath(db, workspaceId, path)
  return documentId !== null
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
// crash between the row delete and the file unlinks below leaves orphan
// blob/thumbnail files (invisible — nothing lists the deleted documentId
// anymore) rather than the reverse — a listed canvas whose content is
// already gone.
// ponytail: orphaned files from that crash window are not swept by
// file-gc (its collectReferencedFileIds targets uploaded images, not these
// canvas/version blobs); revisit if orphan blobs start showing up in the
// storage report.
/**
 * Everything about a document that is neither its `documents` row nor its
 * Libsql bytes: the FS blob, its pre-migration backup, one thumbnail per
 * version, and the cached doc instance. server-core cannot name any of it,
 * so it reaches this through `ServerDeps.documentTeardown` — which is what
 * makes `wb_document_delete` clean up the way the HTTP DELETE does instead
 * of leaving stale files and a stale cache entry behind.
 *
 * Two phases because a thumbnail is filed under a VERSION id, and the
 * versions rows cascade away the instant the document row goes: the ids
 * have to be captured while the document is still whole.
 */
export const documentTeardown: DocumentTeardown = {
  async begin({ workspaceId, documentId, path }) {
    const db = await dbReady()
    const versionRows = await db
      .selectFrom('versions')
      .select(['id'])
      .where('documentId', '=', documentId)
      .execute()

    return async () => {
      const blobPath = documentBlobPath(workspaceId, documentId)
      await unlinkIfExists(blobPath)
      await unlinkIfExists(`${blobPath}.pre-migrate-bak`)
      for (const { id: versionId } of versionRows) {
        await unlinkIfExists(thumbnailPath(workspaceId, versionId))
      }

      // Force the next getDoc() to reload from disk (there is nothing left to
      // reload from — a fresh create should not inherit a doc instance that
      // still holds the deleted canvas's history).
      evictDoc(workspaceId, path)
    }
  },
}

export async function deleteDocument(workspaceId: string, path: string): Promise<boolean> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  return withWorkspaceWriteLock(workspaceId, async () => {
    const db = await dbReady()
    const documentId = await getDocumentIdByPath(db, workspaceId, path)
    if (!documentId) return false

    // Same three steps, in the same order, as wb_document_delete
    // (server-core's document-crud.ts) — deliberately, because the two used
    // to be separate implementations and only one of them cleaned up. Each
    // step is now one shared piece rather than a copy: `deleteDocumentRow`
    // holds the descendant refusal, `documentTeardown` holds the files.
    const finalizeTeardown = await documentTeardown.begin({ workspaceId, documentId, path })

    // The tree node goes through the index's delete, which EVACUATES the
    // content into the trash before removing anything — the daemon's delete
    // keeps the same recoverability promise the agent-facing port makes. A
    // document the tree does not hold (legacy plane) skips this cleanly.
    const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
    if (workspaceDoc !== null && resolveWorkspaceDocumentById(workspaceDoc, documentId) !== null) {
      // Cache-backed, so the index deletes on the same live instance every
      // other path writes through.
      const index = await workspaceTreeIndex()
      await index.deleteDocument({ workspaceId, path })
    }

    await deleteDocumentRow(db, workspaceId, path)

    // The identity row goes first, then the Libsql snapshot/delta/frontier
    // rows, so a crash between the two leaves an orphaned-but-unreachable
    // snapshot rather than a listed canvas with no content.
    const documentStore = await documentStoreReady()
    await documentStore.deleteDoc({ docRef: { kind: 'document', workspaceId, documentId } })

    await finalizeTeardown()

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
  const db = await dbReady()
  const row = await db
    .selectFrom('documents')
    .select(['kind'])
    .where('workspaceId', '=', workspaceId)
    .where('path', '=', path)
    .executeTakeFirst()
  return row?.kind ?? null
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
export async function compactDocument(
  workspaceId: string,
  path: string,
  versionStore: VersionStore,
): Promise<CompactResult> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  const db = await dbReady()
  const documentId = await getDocumentIdByPath(db, workspaceId, path)
  if (!documentId) {
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

    const cut = await versionStore.earliestWorkspaceFrontiers(workspaceId)
    if (!cut) {
      return { compacted: false, beforeBytes, afterBytes: beforeBytes, reason: 'no-versions' }
    }

    // The live cached workspace document IS the current state — every write
    // path mutates it under the lock held here — so the fold exports from
    // it instead of re-reading stored bytes.
    const doc = await getWorkspaceDoc(workspaceId)
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
    // Stamp the canvas row so the auto-Optimize loop can skip documents that
    // have not changed since the last successful compaction, and so the UI
    // can surface "Auto-optimised Ns ago" without reading file mtimes.
    await db
      .updateTable('documents')
      .set({ lastCompactedAt: Date.now() })
      .where('id', '=', documentId)
      .execute()
    // Workspace-level mirror (dual-plane collapse S4b): compaction folds the
    // WORKSPACE record's oplog, so the shared timestamp describes the
    // workspace rather than any one document. Written after the compacted
    // snapshot, as a small delta on top of it.
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
  const row = await db
    .selectFrom('documents')
    .select((eb) => eb.fn.max('lastCompactedAt').as('maxAt'))
    .executeTakeFirst()
  const value = row?.maxAt ?? null
  return value === null || typeof value !== 'number' ? null : value
}

// ── list workspaces from the workspaces table ──
export async function listWorkspaces(): Promise<{ workspaceId: string }[]> {
  const db = await dbReady()
  const rows = await db.selectFrom('workspaces').select(['id', 'updatedAt']).execute()
  return rows.map((r) => ({ workspaceId: r.id }))
}

// ── rename a canvas's path ──
// Updates only documents.path. branches/versions FK on documentId and the blob
// path also uses documentId, so none of that moves. Returns null (never
// throws) for a missing source canvas, matching deleteDocument's boolean-
// shaped "already gone" handling; a rename onto an already-taken path
// throws ConflictError instead of a raw unique-constraint error.
export async function renameDocumentPath(
  workspaceId: string,
  oldPath: string,
  newPath: string,
): Promise<{ documentId: string } | null> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(oldPath)
  validateDocumentPath(newPath)
  return withWorkspaceWriteLock(workspaceId, async () => {
    const db = await dbReady()
    const documentId = await getDocumentIdByPath(db, workspaceId, oldPath)
    if (!documentId) return null
    if (oldPath === newPath) return { documentId }
    // The one rule planSubtreeMove leaves to its callers, and the index's
    // moveDocument already enforces. Without it the depth-ordered write —
    // correct for an upward move — is inverted, and the shallow row lands on
    // a path its own descendant has not vacated, surfacing as a raw unique
    // constraint error instead of an answer the caller can act on.
    if (isSelfOrDescendant(newPath, oldPath)) {
      throw new DocumentMoveIntoSelfError(oldPath, newPath)
    }

    const rows = await db
      .selectFrom('documents')
      .select(['id', 'path'])
      .where('workspaceId', '=', workspaceId)
      .execute()
    const plan = planSubtreeMove(rows, oldPath, newPath)
    if (!plan.ok) {
      // `not-found` is unreachable — getDocumentIdByPath already answered
      // for oldPath — so the only outcome left is a collision.
      const collided = plan.reason === 'taken' ? plan.path : newPath
      throw new ConflictError(`Canvas "${workspaceId}/${collided}" already exists`)
    }

    const now = Date.now()
    await db.transaction().execute(async (trx) => {
      for (const move of plan.moves) {
        await trx
          .updateTable('documents')
          .set({ path: move.path, updatedAt: now })
          .where('id', '=', move.id)
          .execute()
      }
    })

    // The tree mirrors the move: a document the tree holds is re-parented
    // (descendants ride along in the tree for free — the row plan above is
    // the table's spelling of the same subtree move).
    const workspaceDoc = await openWorkspaceDocIfStored(workspaceId)
    if (workspaceDoc !== null && resolveWorkspaceDocumentById(workspaceDoc, documentId) !== null) {
      moveWorkspaceNodeToPath(workspaceDoc, oldPath, newPath)
      await saveWorkspaceDoc(workspaceId, workspaceDoc)
    }

    // Force the next getDoc() to reload under every key the move touched.
    // A source path: a caller still reading through it should lazily create
    // a fresh canvas rather than resurrect the moved doc's cached instance.
    // A destination path: a WS connect or update-route call against it
    // before this move can lazily cache an empty phantom doc there (getDoc()
    // creates one for any path with no DB row yet) — leaving that phantom
    // cached would shadow the just-moved canvas's real content and the next
    // write through it would persist the phantom over it. Both halves apply
    // to every descendant, not only the two paths the caller named.
    for (const move of plan.moves) {
      evictDoc(workspaceId, move.from)
      evictDoc(workspaceId, move.path)
    }
    return { documentId }
  })
}

// ── list documents from the documents table ──
export async function listDocuments(
  workspaceId: string,
): Promise<Pick<DocumentSummary, 'path' | 'id' | 'displayName' | 'updatedAt' | 'kind'>[]> {
  validateWorkspaceId(workspaceId)
  const db = await dbReady()
  const rows = await db
    .selectFrom('documents')
    .select(['path', 'id', 'displayName', 'updatedAt', 'kind'])
    .where('workspaceId', '=', workspaceId)
    .execute()
  return rows.map((r) => {
    // Kind is a stored invariant: every write path records one and the boot
    // fold deletes pre-kind rows, so a null here is corrupt stored data —
    // surfaced, not guessed over.
    if (!r.kind) {
      throw new Error(`document row "${workspaceId}/${r.path}" has no recorded kind`)
    }
    return {
      path: r.path,
      id: r.id,
      // Absent rather than null when unset: a document nobody renamed has no
      // name of its own to report.
      ...(r.displayName ? { displayName: r.displayName } : {}),
      updatedAt: new Date(r.updatedAt).toISOString(),
      kind: r.kind,
    }
  })
}
