import type {
  CompactWorkspaceResult,
  DocumentSummary,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  createWorkspaceDocumentAtPath,
  projectWorkspaceDocument,
  readDocumentKind,
  readTrashEntries,
  readWorkspaceDocuments,
  readWorkspaceMeta,
  resolveWorkspaceDocument,
  resolveWorkspaceDocumentById,
  setWorkspaceLastCompactedAt,
  updateWorkspaceDocumentMeta,
  writeDocumentContentAndName,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import {
  chunkSnapshot,
  DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES,
  DocumentNotFoundError,
  DocumentPathTakenError,
  WorkspaceNotFoundError,
} from '@kamiazya/whiteboard-ports'
import type { DocumentTeardown } from '@kamiazya/whiteboard-server-core'
import type {
  LoroWorkspaceDocumentIndex,
  WorkspaceRegistry,
} from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { getLogger } from '../log.js'
import { blobsRoot } from '../tenant/data-layout.js'
import { validateDocumentPath, validateWorkspaceId } from '../validators.js'
import { CacheCoherentDocumentIndex } from './cache-coherent-document-index.js'
import { renameWorkspaceRow, upsertWorkspaceRow } from './db/upsert-workspace.js'
import { evictDoc, getOrLoad, settleSavedDoc } from './doc-cache.js'
import { FsBlobStore } from './fs/fs-blob-store.js'
import { moveEvictingCache } from './moved-paths.js'
import { documentStoreReady } from './store-handles.js'
import { globalStoreScope, type StoreScope } from './store-scope.js'
import type { VersionStore } from './version-store.js'
import {
  cacheBackedWorkspaceDocs,
  catchUpWorkspaceDoc,
  getWorkspaceDoc,
  openWorkspaceDocIfStored,
  saveWorkspaceDoc,
} from './workspace-doc-cache.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

// The cache's public surface is re-exported so callers keep one import path
// for the document store; the cache itself lives in `workspace-doc-cache.ts`.
export { CacheCoherentDocumentIndex } from './cache-coherent-document-index.js'
export {
  _clearWorkspaceDocCacheForTests,
  cacheBackedWorkspaceDocs,
  catchUpWorkspaceDoc,
  emitWorkspaceDocUpdated,
  evictWorkspaceDocCache,
  getWorkspaceDoc,
  onWorkspaceDocUpdated,
  openWorkspaceDocIfStored,
  saveWorkspaceDoc,
} from './workspace-doc-cache.js'

// Give the error a stable name so callers, including MCP tools, can detect overwrite conflicts.
export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

// No snapshot size cap lives here. An infrastructure ceiling is not a product
// choice — past it the write fails whatever this file does — so
// docs/contributing/adr/0044-workspace-capacity.md decides it as a refusal with
// a migration band below the limit, not as a warning.

/** The documentId at `path`, or null when the workspace tree does not serve it. */
export async function resolveDocumentIdAtPath(
  workspaceId: string,
  path: string,
  scope: StoreScope = globalStoreScope,
): Promise<string | null> {
  const workspaceDoc = await openWorkspaceDocIfStored(workspaceId, scope)
  if (workspaceDoc === null) return null
  const entry = resolveWorkspaceDocument(workspaceDoc, path)
  return entry === null ? null : entry.documentId
}

/** `resolveDocumentIdAtPath` that throws the routes' 404-mapped error instead of answering null. */
export async function requireDocumentAtPath(
  workspaceId: string,
  path: string,
  scope: StoreScope = globalStoreScope,
): Promise<string> {
  const documentId = await resolveDocumentIdAtPath(workspaceId, path, scope)
  if (documentId === null) throw new DocumentNotFoundError(workspaceId, path)
  return documentId
}

/**
 * The workspaces REGISTRY, read from the daemon's `workspaces` table — the
 * one row-shaped truth the collapse kept (who this daemon keeps, not what
 * they contain). `saveWorkspaceDoc` upserts it, so a workspace exists here
 * exactly when a stored record does.
 *
 * Serves ADR-0019's `segment`/`displayName` identity layers when the row
 * carries them — absent, never `null`/`''`, for a legacy workspace that
 * predates migration 0018 or was never given either.
 */
export function workspaceRegistry(scope: StoreScope = globalStoreScope): WorkspaceRegistry {
  return {
    async listWorkspaces() {
      const db = await scope.db()
      const rows = await db
        .selectFrom('workspaces')
        .select(['id', 'segment', 'displayName'])
        .execute()
      return rows.map((row) => ({
        workspaceId: row.id,
        ...(row.segment === null ? {} : { segment: row.segment }),
        ...(row.displayName === null ? {} : { displayName: row.displayName }),
      }))
    },
    /**
     * The registry's write half. Identity is a ROW here, so this is the
     * whole rename — the workspace's tree document holds placement and is
     * untouched by it.
     */
    async renameWorkspace(input) {
      // Unvalidated on purpose: `CacheCoherentDocumentIndex.renameWorkspace`
      // parses at the boundary before it gets here, exactly as it does for
      // `createWorkspace`, and this registry is reached only through it. A
      // second parse would be a guard no test can reach — one was written,
      // and its mutation check stayed green.
      const updated = await renameWorkspaceRow(await scope.db(), input.workspaceId, {
        ...(input.segment === undefined ? {} : { segment: input.segment }),
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      })
      // No row updated means no such workspace. Distinguished here rather
      // than by a preceding SELECT, which would be a second statement
      // another writer could land a delete between.
      if (updated === null) throw new WorkspaceNotFoundError(input.workspaceId)
      return {
        workspaceId: input.workspaceId,
        ...(updated.segment === null ? {} : { segment: updated.segment }),
        ...(updated.displayName === null ? {} : { displayName: updated.displayName }),
      }
    },
  }
}

/** The tree index delete/rename/pin go through, so a daemon delete evacuates the same way a port delete does. */
export async function workspaceTreeIndex(scope: StoreScope): Promise<LoroWorkspaceDocumentIndex> {
  return new CacheCoherentDocumentIndex(
    cacheBackedWorkspaceDocs(scope),
    new FsBlobStore(blobsRoot(scope.dataDir, scope.layout.tenantId), scope.dataDir),
    workspaceRegistry(scope),
    scope,
  )
}

/**
 * Put this document's content in the workspace tree, creating its node when
 * the path is new.
 *
 * A save that names no kind and finds none on the tree or in the doc's own
 * bytes is a lazy-create of an empty document (an update route hit on an
 * unknown path); the spatial editor is what opens those, so `'spatial'` is
 * the honest default — not a guess about someone else's data.
 *
 * An EXPLICIT kind is an intentional sync request (restore reconciling a
 * different-kind source's content onto an existing target); a plain re-save
 * omits it and must never touch the value.
 *
 * The write answers false when the tree already gave this path to a
 * DIFFERENT document. With no legacy plane to fall back to, writing anywhere
 * else would fork storage silently, so it refuses loudly instead.
 */
function placeDocumentInTree({
  workspaceDoc,
  workspaceId,
  path,
  documentId,
  existingEntry,
  requestedKind,
  doc,
}: {
  workspaceDoc: LoroDoc
  workspaceId: string
  path: string
  documentId: string
  existingEntry: ReturnType<typeof resolveWorkspaceDocument>
  requestedKind: DocumentKind | undefined
  doc: LoroDoc
}): void {
  const kindForTree = requestedKind ?? existingEntry?.kind ?? readDocumentKind(doc) ?? 'spatial'
  if (existingEntry === null) {
    createWorkspaceDocumentAtPath(workspaceDoc, { path, documentId, kind: kindForTree })
  } else if (requestedKind !== undefined && existingEntry.kind !== requestedKind) {
    updateWorkspaceDocumentMeta(workspaceDoc, documentId, { kind: requestedKind })
  }
  if (!writeDocumentContentAndName(workspaceDoc, documentId, doc)) {
    throw new ConflictError(
      `Path "${workspaceId}/${path}" is held by a different document in the workspace tree.`,
    )
  }
}

// ── save LoroDoc by writing the snapshot binary to the blobs/ tree and
//    upserting the matching DB rows. ──
// overwrite defaults to false so canvas_create does not destroy existing
// data by mistake. Normal incremental saves (update-route writes, live-doc and
// restore writes, compactDocument) must pass overwrite: true.
/**
 * Called after every successful `saveDocument`.
 *
 * A plain notification, not a compaction hook: the store does not name a
 * subscriber such as the auto-compact debouncer, which is how it would come to
 * know about compaction at all. What it has to say is "this document changed", and who cares is not its business.
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
  scope: StoreScope = globalStoreScope,
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
    const db = await scope.db()
    // The workspace REGISTRY row is still real (workspaceExists answers from
    // it); the documents rows are not written here — the tree is the
    // whole record of what exists.
    await upsertWorkspaceRow(db, workspaceId)
    const workspaceDoc = await getWorkspaceDoc(workspaceId, scope)
    const existingEntry = resolveWorkspaceDocument(workspaceDoc, path)
    const existingDocumentId = existingEntry?.documentId ?? null
    if (existingDocumentId !== null && options.overwrite !== true) {
      throw new ConflictError(
        `Document "${workspaceId}/${path}" already exists. Pass { overwrite: true } to replace it.`,
      )
    }
    // A ULID, not a nanoid: the document index creates documents in this
    // same tree and the port's DocumentEntry accepts only a canonical ULID,
    // so a second minting policy here would keep producing documents the
    // agent surface has to skip. One tree, one id space.
    const documentId = existingDocumentId ?? generateDocumentId()
    placeDocumentInTree({
      workspaceDoc,
      workspaceId,
      path,
      documentId,
      existingEntry,
      requestedKind: options.kind,
      doc,
    })
    await saveWorkspaceDoc(workspaceId, workspaceDoc, scope)
    // A caller may hand this function a doc that is NOT the cached
    // projection (a fresh import, a checkout clone), or the empty stand-in a
    // read of an unplaced path was answered with. Self-heal at the funnel
    // entry instead of trusting every such caller to remember to evict.
    settleSavedDoc(workspaceId, path, doc, scope)
    notifyDocumentSaved(workspaceId, path)
  })
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

/**
 * `loadDocument` through the resident LRU (doc-cache.ts), which is what most
 * callers want: a sync update, an export, and a version read of the same
 * document within a session should share one LoroDoc rather than each
 * rebuilding several MiB of CRDT history. Reach for `loadDocument` directly
 * only when a *fresh* instance is the point.
 */
export async function getDoc(
  workspaceId: string,
  path: string,
  scope: StoreScope = globalStoreScope,
): Promise<LoroDoc> {
  // A cached projection is current while the workspace record it was cut
  // from is: every write THIS process makes mutates it in place (saveDocument
  // diffs against the live workspace doc), and what another process writes
  // reaches it only through the record. So the record is asked first —
  // reading it through is what evicts the projections a foreign write
  // outdated — and the cache then serves what is left. No per-document
  // delta replay runs here: replaying a legacy oplog into a projection would
  // resurrect pre-fold state over current content.
  validateWorkspaceId(workspaceId)
  await openWorkspaceDocIfStored(workspaceId, scope)
  return getOrLoad(workspaceId, path, () => loadPlacedDocument(workspaceId, path, scope), scope)
}

/**
 * Whether this daemon has ever registered the workspace.
 *
 * Exists so read surfaces can tell "empty" from "never heard of it". Nothing
 * mints workspace ids ahead of use, but ids OUTLIVE the daemon that
 * minted them — a browser keeps its daemon workspace id in localStorage, and
 * a rebuilt data dir does not know it. Answering such an id with empty lists
 * and lazily-created empty docs reads exactly like the user's data being
 * gone, when the truth is "not here".
 */
export async function workspaceExists(
  workspaceId: string,
  scope: StoreScope = globalStoreScope,
): Promise<boolean> {
  validateWorkspaceId(workspaceId)
  const db = await scope.db()
  const row = await db
    .selectFrom('workspaces')
    .select(['id'])
    .where('id', '=', workspaceId)
    .executeTakeFirst()
  return row !== undefined
}

export async function documentExists(
  workspaceId: string,
  path: string,
  scope: StoreScope = globalStoreScope,
): Promise<boolean> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  return (await resolveDocumentIdAtPath(workspaceId, path, scope)) !== null
}

// ── delete a document and every file it owns ──
// Returns false (never throws) for a missing document so callers can treat
// "already gone" and "just deleted" the same way an idempotent DELETE
// should.
//
/**
 * Everything about a document that is neither Libsql bytes nor a workspace
 * tree node: its versions rows and the cached doc instance. server-core
 * cannot name any of it, so it reaches this through
 * `ServerDeps.documentTeardown` — which is what makes `wbDocumentDelete`
 * clean up the way the HTTP DELETE does instead of leaving a stale cache
 * entry behind.
 *
 * Version rows outlive a delete that put the document in the trash: a
 * restore brings it back under the same documentId the rows are keyed by,
 * so they are its history, and `CacheCoherentDocumentIndex.purgeTrashEntry`
 * is where they go. The browser keeper draws the line at the same point.
 *
 * The row delete and the document delete are separate statements, not one
 * transaction — a crash between them leaves orphaned versions rows.
 * ponytail: acceptable while nothing lists rows by dangling documentId;
 * a boot-time orphan sweep is the upgrade path if they ever show up.
 */
export function createDocumentTeardown(scope: StoreScope = globalStoreScope): DocumentTeardown {
  return {
    around({ workspaceId, documentId, path }, deleteDocument) {
      // The whole delete runs under this workspace's write barrier, so a
      // version saved mid-delete cannot land after the sweep below.
      return withWorkspaceWriteLock(workspaceId, async () => {
        const db = await scope.db()
        const result = await deleteDocument()

        // Version rows no longer cascade from a documents row (migration 0016
        // dropped the FK — a tree-only document has no row to cascade from), so
        // delete-completeness lives here for a delete that left nothing a
        // restore could bring back, and in the purge for one that did.
        if (!(await isInTrash(workspaceId, documentId, scope))) {
          await db.deleteFrom('versions').where('documentId', '=', documentId).execute()
        }

        // Force the next getDoc() to reload from disk (there is nothing left to
        // reload from — a fresh create should not inherit a doc instance that
        // still holds the deleted document's history).
        evictDoc(workspaceId, path, scope)

        return result
      })
    },
  }
}

async function isInTrash(
  workspaceId: string,
  documentId: string,
  scope: StoreScope,
): Promise<boolean> {
  const workspaceDoc = await openWorkspaceDocIfStored(workspaceId, scope)
  if (workspaceDoc === null) return false
  return readTrashEntries(workspaceDoc).some((entry) => entry.documentId === documentId)
}

export async function deleteDocument(
  workspaceId: string,
  path: string,
  scope: StoreScope = globalStoreScope,
): Promise<boolean> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  const documentId = await resolveDocumentIdAtPath(workspaceId, path, scope)
  if (documentId === null) return false

  // The same bracket wbDocumentDelete runs in (server-core's
  // document-crud.ts) — deliberately, so no delete path can skip the
  // cleanup. The bracket takes the
  // workspace write lock and deletes the versions rows after the document
  // goes (migration 0016 dropped the cascade).
  return createDocumentTeardown(scope).around({ workspaceId, documentId, path }, async () => {
    // The tree node goes through the index's delete, which EVACUATES the
    // content into the trash before removing anything — the daemon's delete
    // keeps the same recoverability promise the agent-facing port makes.
    // `documentId` came from the tree above, so the node is guaranteed to
    // still be there unless a concurrent delete already removed it.
    const workspaceDoc = await openWorkspaceDocIfStored(workspaceId, scope)
    if (workspaceDoc !== null && resolveWorkspaceDocumentById(workspaceDoc, documentId) !== null) {
      // Cache-backed, so the index deletes on the same live instance every
      // other path writes through.
      const index = await workspaceTreeIndex(scope)
      await index.deleteDocument({ workspaceId, path })
    }

    // The identity goes first, then the Libsql snapshot/delta/frontier
    // rows, so a crash between the two leaves an orphaned-but-unreachable
    // snapshot rather than a listed document with no content.
    const documentStore = await documentStoreReady(scope)
    await documentStore.deleteDoc({ docRef: { kind: 'document', workspaceId, documentId } })

    return true
  })
}

// Null for both "no such document" and "the document records no kind" — its
// callers want the same thing from either, which is to stamp nothing.
//
// This deliberately does NOT resolve an unset kind to 'spatial' the way
// listDocuments does. The difference is what the answer is used for: a list
// renders a badge, while this feeds a WRITE onto a restored document's row.
// A guess that gets stored outlives the guess — a markdown document that
// predates kinds would become permanently spatial and open in the wrong
// editor, which is the exact failure the callers' comments say they are
// copying the source's kind to avoid.
export async function getDocumentKind(
  workspaceId: string,
  path: string,
  scope: StoreScope = globalStoreScope,
): Promise<DocumentKind | null> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(path)
  const workspaceDoc = await openWorkspaceDocIfStored(workspaceId, scope)
  if (workspaceDoc === null) return null
  return resolveWorkspaceDocument(workspaceDoc, path)?.kind ?? null
}

/**
 * Compacts the WORKSPACE record: a shallow snapshot cut at the earliest
 * frontiers any workspace-scoped version still needs, superseding the delta
 * log it folded. Addressed by workspace, because that is the unit: every
 * document lives in the one record, so there is nothing smaller to compact,
 * and a caller that fans out per document only buys N-1 full shallow exports
 * that answer 'no-gain'.
 *
 * The cut is the earliest workspace-scoped version frontier, full stop.
 * ADR-0029 retired the branch, so there is no second pin and no checkout to
 * protect (a branch tip holding the cut back made the folded record ~75%
 * larger on a one-tip fixture).
 *
 * The result is the daemon's published shape (`compactWorkspaceResultSchema`
 * in daemon-client), typed from the schema so the route that answers with it
 * and the store that produces it cannot drift apart.
 */
export async function compactWorkspace(
  workspaceId: string,
  versionStore: VersionStore,
  scope: StoreScope = globalStoreScope,
): Promise<CompactWorkspaceResult> {
  validateWorkspaceId(workspaceId)
  const documentStore = await documentStoreReady(scope)
  const docRef = { kind: 'workspace-tree' as const, workspaceId }

  // The workspace lock is what every workspace-record writer holds, so the
  // read that decides the shallow snapshot and the write that persists it
  // see no concurrent tree write in between.
  return withWorkspaceWriteLock(workspaceId, async () => {
    // Same reason file-GC catches up first (ADR-0020): the fold below exports
    // a shallow snapshot from the CACHED document, and a cached document that
    // is behind produces a snapshot missing another instance's ops. The
    // generation fence does not cover it — a writer that merely APPENDED left
    // the generation alone, and `supersededDeltaCount` then drops the very
    // delta that carried those ops.
    await catchUpWorkspaceDoc(workspaceId, scope)
    const header = await documentStore.readSnapshotManifest({ docRef })
    if (header === null) {
      return { compacted: false, beforeBytes: 0, afterBytes: 0, reason: 'no-file' }
    }
    const { manifest } = header
    const { updates: storedDeltas } = await documentStore.loadDeltas({
      docRef,
      afterSeq: null,
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
    const doc = await getWorkspaceDoc(workspaceId, scope)

    // The earliest version row is the whole cut: it is the oldest point any
    // reader can still ask to see. No version row still means no compaction
    // at all, which is the guard above.
    const shallow = doc.export({ mode: 'shallow-snapshot', frontiers: earliestVersion })
    if (shallow.byteLength >= beforeBytes) {
      return { compacted: false, beforeBytes, afterBytes: beforeBytes, reason: 'no-gain' }
    }
    const { manifest: fresh, chunks } = chunkSnapshot(
      new Uint8Array(shallow),
      DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES,
    )
    const folded = await documentStore.saveCompactedSnapshot({
      docRef,
      manifest: fresh,
      chunks,
      frontier: new Uint8Array(doc.oplogVersion().encode()),
      // Exactly the log this fold consumed. Anything appended since the read
      // above is neither in `shallow` nor superseded by it, and dropping it
      // would lose an edit that arrived while compaction ran.
      supersededDeltaCount: storedDeltas.length,
      // ADR-0020. The workspace lock above serialises writers inside THIS
      // process; the fence is what covers a second process. Ignoring the
      // refusal is deliberate here and only here: this path folds history
      // that is already durable rather than carrying new ops, so losing the
      // race costs a compaction, not an edit, and the next save folds again.
      expectedGeneration: header.generation,
    })
    if (!folded.ok) {
      // Another writer replaced the snapshot while this fold ran. Nothing was
      // written and nothing was lost — this fold carried no new ops, only a
      // shorter rendering of history that is already durable — so the honest
      // answer is that no compaction happened, and the next save folds again.
      return { compacted: false, beforeBytes, afterBytes: beforeBytes, reason: 'raced' }
    }
    // Compaction folds the WORKSPACE record's oplog, so the timestamp the
    // storage report shows describes the workspace, on the workspace meta.
    // Written after the compacted snapshot, as a small delta on top of it.
    setWorkspaceLastCompactedAt(doc, Date.now())
    await saveWorkspaceDoc(workspaceId, doc, scope)
    // No eviction: the live workspace document keeps its full in-memory
    // history and the frontier just written is its own current one, so both
    // it and the projections served from it stay coherent with the store.
    return { compacted: true, beforeBytes, afterBytes: shallow.byteLength, reason: 'ok' }
  })
}

// ── most-recent auto-compact timestamp across all documents ───────────
// Used by the storage report to show "Auto-optimised Ns ago" without
// client-side aggregation. Returns null when no document has been compacted yet.
export async function readLatestCompactedAt(
  scope: StoreScope = globalStoreScope,
): Promise<number | null> {
  const db = await scope.db()
  const workspaces = await db.selectFrom('workspaces').select(['id']).execute()
  let latest: number | null = null
  for (const { id } of workspaces) {
    const workspaceDoc = await openWorkspaceDocIfStored(id, scope)
    if (workspaceDoc === null) continue
    const at = readWorkspaceMeta(workspaceDoc).lastCompactedAt
    if (at !== undefined && (latest === null || at > latest)) latest = at
  }
  return latest
}

// ── list workspaces from the workspaces table ──
export async function listWorkspaces(
  scope: StoreScope = globalStoreScope,
): Promise<{ workspaceId: string }[]> {
  const db = await scope.db()
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
  scope: StoreScope = globalStoreScope,
): Promise<{ documentId: string } | null> {
  validateWorkspaceId(workspaceId)
  validateDocumentPath(oldPath)
  validateDocumentPath(newPath)
  return withWorkspaceWriteLock(workspaceId, async () => {
    const workspaceDoc = await openWorkspaceDocIfStored(workspaceId, scope)
    const entry = workspaceDoc === null ? null : resolveWorkspaceDocument(workspaceDoc, oldPath)
    // A path only the rows know is a pre-fold legacy document; renaming one
    // before the boot fold has absorbed it is not a supported operation —
    // the fold will place it, and the rename can happen after.
    if (entry === null) return null
    const documentId = entry.documentId
    if (oldPath === newPath) return { documentId }

    await moveEvictingCache(workspaceId, oldPath, newPath, scope, workspaceDoc, () =>
      moveThroughIndex(workspaceId, oldPath, newPath, scope),
    )
    return { documentId }
  })
}

/**
 * The index's move owns the collision rules (occupied destination,
 * move-into-self, folder promotion) — one definition, not a second
 * rows-shaped copy of it. Only the taken-path refusal is translated, because
 * that one has a wire shape of its own.
 */
async function moveThroughIndex(
  workspaceId: string,
  oldPath: string,
  newPath: string,
  scope: StoreScope,
): Promise<void> {
  const index = await workspaceTreeIndex(scope)
  try {
    await index.moveDocument({ workspaceId, from: oldPath, to: newPath })
  } catch (err) {
    if (err instanceof DocumentPathTakenError) {
      throw new ConflictError(`Document "${workspaceId}/${err.path}" already exists`)
    }
    throw err
  }
}

// ── list documents from the workspace record ──
export async function listDocuments(
  workspaceId: string,
  scope: StoreScope = globalStoreScope,
): Promise<
  Pick<DocumentSummary, 'path' | 'documentId' | 'name' | 'updatedAt' | 'kind' | 'contentDigest'>[]
> {
  validateWorkspaceId(workspaceId)
  const workspaceDoc = await openWorkspaceDocIfStored(workspaceId, scope)
  if (workspaceDoc === null) return []
  return readWorkspaceDocuments(workspaceDoc).map((entry) => ({
    path: entry.path,
    documentId: entry.documentId,
    // Absent rather than null when unset: a document nobody renamed has no
    // name of its own to report.
    ...(entry.name === undefined ? {} : { name: entry.name }),
    // Every tree write stamps updatedAt and the fold carries the row
    // value; a record written before that stamp existed simply has none,
    // and the epoch is the honest "unknown" for our own pre-release data.
    updatedAt: new Date(entry.updatedAt ?? entry.createdAt ?? 0).toISOString(),
    kind: entry.kind,
    contentDigest: entry.contentDigest,
  }))
}
