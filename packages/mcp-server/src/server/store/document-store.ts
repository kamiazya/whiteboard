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
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import {
  chunkSnapshot,
  DocumentMoveIntoSelfError,
  isSelfOrDescendant,
  planSubtreeMove,
  reassembleSnapshot,
} from '@kamiazya/whiteboard-ports'
import type { DocumentTeardown } from '@kamiazya/whiteboard-server-core'
import type { Value } from 'loro-crdt'
import { LoroDoc, LoroMap, VersionVector } from 'loro-crdt'
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
import { evictDoc, getOrLoad, peekDoc } from './doc-cache.js'
import { LibsqlDocumentStore } from './libsql/libsql-document-store.js'
import type { VersionStore } from './version-store.js'
import { thumbnailPath } from './version-store.js'
import { withDocumentWriteLock, withWorkspaceWriteLock } from './workspace-lock.js'

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
const SNAPSHOT_WARN_BYTES = 32 * 1024 * 1024 // 32 MiB
const warnedSnapshots = new Set<string>()

async function dbReady() {
  await prepareDataDir(getDataDir())
  return getDb(getDataDir())
}

// The MCP tool surface (server-core's ServerDeps) builds its own instance
// from the same one-db-per-dataDir Kysely handle, so both sides read/write
// the same `document:<documentId>` rows. The class is a stateless wrapper
// around that handle, so a fresh instance per call is equivalent.
async function documentStoreReady(): Promise<LibsqlDocumentStore> {
  return new LibsqlDocumentStore(await dbReady())
}

// Chunk + replace a document's snapshot rows under the canvas-doc write
// lock. Every mutating MCP tool serializes its load-modify-save against
// this same key (workspace-lock.ts's withDocumentWriteLock) — since both
// paths write the same Libsql rows, taking it here closes the lost-update
// window between the HTTP/WS save path and an agent's tool call racing on
// the SAME document. Callers hold the workspace lock first; that nesting
// direction is safe because no code path ever acquires the canvas-doc lock
// and then reaches for the workspace lock, so there is no cycle to
// deadlock on.
async function saveSnapshotLocked(
  documentStore: LibsqlDocumentStore,
  documentId: string,
  snapshot: Uint8Array,
  frontier: Uint8Array<ArrayBuffer>,
): Promise<void> {
  await withDocumentWriteLock(documentId, async () => {
    const { manifest, chunks } = chunkSnapshot(snapshot, SNAPSHOT_MAX_CHUNK_BYTES)
    await documentStore.saveSnapshot({
      docRef: { kind: 'document', documentId },
      manifest,
      chunks,
      frontier,
    })
  })
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
  documentId: string,
  doc: LoroDoc,
): Promise<void> {
  const docRef = { kind: 'document' as const, documentId }
  const stored = await documentStore.readFrontier({ docRef })
  if (stored === null) return
  const comparison = doc.oplogVersion().compare(VersionVector.decode(stored.frontier))
  // `undefined` means the two histories diverged — neither is a prefix of the
  // other — which is still a reason to merge, not to ignore.
  if (comparison !== undefined && comparison >= 0) return
  const existing = await documentStore.loadSnapshot({ docRef })
  if (existing !== null) doc.import(reassembleSnapshot(existing.manifest, existing.chunks))
}

async function mergeAndSaveSnapshotLocked(
  documentStore: LibsqlDocumentStore,
  workspaceId: string,
  documentId: string,
  doc: LoroDoc,
): Promise<number> {
  const docRef = { kind: 'document' as const, documentId }
  return withDocumentWriteLock(documentId, async () => {
    try {
      await importStoredIfBehind(documentStore, documentId, doc)
    } catch (err) {
      getLogger('document').warning(
        { workspaceId, documentId, err: err as Error },
        'stored snapshot failed to merge before save; overwriting',
      )
    }
    const snapshot = doc.export({ mode: 'snapshot' })
    const { manifest, chunks } = chunkSnapshot(snapshot, SNAPSHOT_MAX_CHUNK_BYTES)
    await documentStore.saveSnapshot({
      docRef,
      manifest,
      chunks,
      frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
    })
    return snapshot.byteLength
  })
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
    const documentStore = await documentStoreReady()
    const savedBytes = await mergeAndSaveSnapshotLocked(documentStore, workspaceId, documentId, doc)
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
          // Written on insert. The update branch above honors an explicit
          // `kind` too (a plain re-save omits it and leaves the stored value
          // untouched); the onConflict branch below is the rare
          // insert-raced-with-a-concurrent-insert fallback and, like a plain
          // re-save, does not touch `kind`.
          kind: options.kind ?? null,
        })
        .onConflict((oc) => oc.columns(['workspaceId', 'path']).doUpdateSet({ updatedAt: now }))
        .execute()
    }
    if (savedBytes > SNAPSHOT_WARN_BYTES) {
      const key = `${workspaceId}/${path}`
      if (!warnedSnapshots.has(key)) {
        warnedSnapshots.add(key)
        getLogger('document-store').warning(
          {
            workspaceId,
            path,
            bytes: savedBytes,
            thresholdBytes: SNAPSHOT_WARN_BYTES,
          },
          'snapshot exceeds soft cap; consider compactDocument() to GC op-log',
        )
      }
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
  // Purely a stable identity label for corrupt-data error messages and the
  // legacy-migration backup file below — no longer an FS path this function
  // reads from.
  const blobPath = documentBlobPath(workspaceId, documentId)
  const documentStore = await documentStoreReady()
  let doc: LoroDoc
  let originalBytes: Uint8Array
  try {
    const snapshot = await documentStore.loadSnapshot({
      docRef: { kind: 'document', documentId },
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
      const db = await dbReady()
      const documentId = await getDocumentIdByPath(db, workspaceId, path)
      if (documentId) {
        await importStoredIfBehind(await documentStoreReady(), documentId, cached)
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

    await deleteDocumentRow(db, workspaceId, path)

    // The identity row goes first, then the Libsql snapshot/delta/frontier
    // rows, so a crash between the two leaves an orphaned-but-unreachable
    // snapshot rather than a listed canvas with no content.
    const documentStore = await documentStoreReady()
    await documentStore.deleteDoc({ docRef: { kind: 'document', documentId } })

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
  const docRef = { kind: 'document' as const, documentId }

  // Hold the canvas-doc write lock across the read that decides the shallow
  // snapshot AND the write that persists it. Previously only the final
  // saveSnapshotLocked call was locked, so a concurrent canvas-doc write (an
  // MCP tool call, or a WS/HTTP save) landing between this function's reads
  // and its write was invisible to both reads and got silently discarded by
  // the shallow write that followed — the same lost-update class
  // saveDocument's own write already guards against, now reachable here too
  // because compaction's target and the tool surface's target are the same
  // Libsql rows.
  return withDocumentWriteLock(documentId, async () => {
    const existing = await documentStore.loadSnapshot({ docRef })
    if (existing === null) {
      return { compacted: false, beforeBytes: 0, afterBytes: 0, reason: 'no-file' }
    }
    const beforeBytes = existing.manifest.totalBytes

    const cut = await versionStore.earliestFrontiers(workspaceId, path)
    if (!cut) {
      return { compacted: false, beforeBytes, afterBytes: beforeBytes, reason: 'no-versions' }
    }

    // Decode inline rather than delegating to loadDocument(): that function
    // also runs a one-shot legacy-migration that calls saveDocument, which
    // would acquire the workspace lock while this canvas-doc lock is still
    // held — the opposite of every other caller's nesting order (workspace
    // lock outer, canvas-doc lock inner, per this module's header comment)
    // and a lock-order-inversion deadlock waiting to happen against a
    // concurrent saveDocument on the same document. Skipping migration here
    // is safe: it is idempotent and re-runs on the next ordinary
    // loadDocument() call, so compaction just defers it rather than losing it.
    const blobPath = documentBlobPath(workspaceId, documentId)
    let originalBytes: Uint8Array
    try {
      originalBytes = reassembleSnapshot(existing.manifest, existing.chunks)
    } catch (error) {
      throw corruptStoredData(blobPath, `invalid canvas snapshot chunks (${errorMessage(error)})`, {
        locationKind: 'identity',
      })
    }
    let doc: LoroDoc
    try {
      doc = LoroDoc.fromSnapshot(originalBytes)
    } catch (error) {
      throw corruptStoredData(blobPath, `invalid canvas snapshot (${errorMessage(error)})`, {
        locationKind: 'identity',
      })
    }

    const shallow = doc.export({ mode: 'shallow-snapshot', frontiers: cut })
    if (shallow.byteLength >= beforeBytes) {
      return { compacted: false, beforeBytes, afterBytes: beforeBytes, reason: 'no-gain' }
    }
    await saveSnapshotLocked(
      documentStore,
      documentId,
      shallow,
      doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
    )
    // Stamp the canvas row so the auto-Optimize loop can skip documents that
    // have not changed since the last successful compaction, and so the UI
    // can surface "Auto-optimised Ns ago" without reading file mtimes.
    await db
      .updateTable('documents')
      .set({ lastCompactedAt: Date.now() })
      .where('id', '=', documentId)
      .execute()
    // Drop the cached LoroDoc for this canvas. Without this, a still-resident
    // full doc (held open by an active WS connection or a previous getDoc)
    // would be re-exported on the next save and clobber the shallow snapshot
    // we just wrote. Done inside compactDocument so every caller — manual
    // optimize_canvases route and the debounced auto-compact alike — gets
    // the same invariant for free.
    evictDoc(workspaceId, path)
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
  return rows.map((r) => ({
    path: r.path,
    id: r.id,
    // Absent rather than null when unset, the same shape rule `kind` follows
    // below: a document nobody renamed has no name of its own to report.
    ...(r.displayName ? { displayName: r.displayName } : {}),
    updatedAt: new Date(r.updatedAt).toISOString(),
    // No guess: an unrecorded kind is reported as absent (see
    // canvasSummarySchema). The row is still listed — only the claim about
    // its kind is withheld.
    ...(r.kind ? { kind: r.kind } : {}),
  }))
}
