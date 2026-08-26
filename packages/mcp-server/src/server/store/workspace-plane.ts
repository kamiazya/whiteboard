/**
 * The dual-plane wiring the composition root injects into server-core, so
 * the agent tool surface and the daemon's own routes see ONE document.
 *
 * server-core addresses content as `document:` refs on the `DocumentStore`
 * port and placement through the `DocumentIndex` port. After the
 * workspace-document cutover, content lives on the workspace tree — so a
 * tool surface left on the raw store would read pre-fold copies and write
 * edits the web app never sees. These wrappers route both ports through the
 * tree while the `documents` table remains the placement/listing mirror
 * (versions, branches and the fold still key off it).
 */
import {
  createWorkspaceDocumentAtPath,
  moveWorkspaceNodeToPath,
  readDocumentKind,
  resolveWorkspaceDocumentById,
  setWorkspaceDocumentName,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { documentKindSchema } from '@kamiazya/whiteboard-model'
import type {
  AppendDeltasInput,
  AppendDeltasResult,
  CreateDocumentInput,
  CreateWorkspaceInput,
  DeleteDocInput,
  DeleteDocumentInput,
  DocumentEntry,
  DocumentIndex,
  DocumentStore,
  ListDocumentsInput,
  LoadDeltasInput,
  LoadDeltasResult,
  LoadSnapshotInput,
  LoadSnapshotResult,
  MoveDocumentInput,
  ReadFrontierInput,
  ReadFrontierResult,
  ReadSnapshotManifestInput,
  ReadSnapshotManifestResult,
  ResolveDocumentByIdInput,
  ResolveDocumentInput,
  SaveCompactedSnapshotInput,
  SaveSnapshotInput,
  SetDocumentNameInput,
} from '@kamiazya/whiteboard-ports'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroWorkspaceDocumentIndex } from '@kamiazya/whiteboard-workspace-index'
import type { Kysely } from 'kysely'
import { LoroDoc } from 'loro-crdt'
import { getDataDir } from '../config.js'
import type { DatabaseSchema } from './db/schema.js'
import { evictDoc } from './doc-cache.js'
import {
  cacheBackedWorkspaceDocs,
  getDoc,
  getWorkspaceDoc,
  openWorkspaceDocIfStored,
  saveWorkspaceDoc,
} from './document-store.js'
import { FsBlobStore } from './fs/fs-blob-store.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

const SNAPSHOT_MAX_CHUNK_BYTES = 1_000_000

interface DocumentRow {
  workspaceId: string
  path: string
  kind: string | null
}

async function documentRowById(
  db: Kysely<DatabaseSchema>,
  documentId: string,
): Promise<DocumentRow | undefined> {
  return db
    .selectFrom('documents')
    .select(['workspaceId', 'path', 'kind'])
    .where('id', '=', documentId)
    .executeTakeFirst()
}

/**
 * `DocumentStore` whose `document:` refs read and write THROUGH the
 * workspace tree when the tree holds the document, delegating everything
 * else — `workspace-tree` refs included — to the inner store. The tool
 * surface keeps its per-document mental model; only where the bytes live
 * changes.
 */
export class WorkspaceRoutedDocumentStore implements DocumentStore {
  constructor(
    private readonly inner: DocumentStore,
    private readonly db: Kysely<DatabaseSchema>,
  ) {}

  async loadSnapshot(input: LoadSnapshotInput): Promise<LoadSnapshotResult> {
    if (input.docRef.kind === 'document') {
      const row = await documentRowById(this.db, input.docRef.documentId)
      if (row !== undefined) {
        const workspaceDoc = await openWorkspaceDocIfStored(row.workspaceId)
        if (
          workspaceDoc !== null &&
          resolveWorkspaceDocumentById(workspaceDoc, input.docRef.documentId) !== null
        ) {
          // Served from the SAME cached projection the route path mutates —
          // not a fresh per-call projection — so a tool's load-modify-save
          // round-trips through one lineage and its save is a real CRDT
          // merge (tombstones included) instead of a value diff against a
          // stranger's history.
          const doc = await getDoc(row.workspaceId, row.path)
          const bytes = new Uint8Array(doc.export({ mode: 'snapshot' }))
          const { manifest, chunks } = chunkSnapshot(bytes, SNAPSHOT_MAX_CHUNK_BYTES)
          return {
            manifest,
            chunks,
            frontier: new Uint8Array(doc.oplogVersion().encode()),
          }
        }
      }
    }
    return this.inner.loadSnapshot(input)
  }

  async readSnapshotManifest(
    input: ReadSnapshotManifestInput,
  ): Promise<ReadSnapshotManifestResult> {
    if (input.docRef.kind === 'document') {
      // Derived from the same projection loadSnapshot serves, so the two
      // answers can never disagree about whether a base exists.
      const loaded = await this.loadSnapshot({ docRef: input.docRef })
      return loaded === null ? null : loaded.manifest
    }
    return this.inner.readSnapshotManifest(input)
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<void> {
    if (input.docRef.kind === 'document') {
      const { documentId } = input.docRef
      const row = await documentRowById(this.db, documentId)
      if (row !== undefined) {
        const doc = new LoroDoc()
        doc.import(reassembleSnapshot(input.manifest, input.chunks))
        const parsedRowKind = documentKindSchema.safeParse(row.kind)
        const kind: DocumentKind | null = parsedRowKind.success
          ? parsedRowKind.data
          : (readDocumentKind(doc) ?? null)
        if (kind !== null) {
          // Under the workspace write lock, like every other writer of the
          // live workspace document — the route save path holds it too, so a
          // tool write and a route save on the same workspace settle into a
          // definite order instead of interleaving their diff-writes. Safe
          // to acquire while the tool surface's canvas-doc lock is held:
          // the lock is re-entrant per async chain and nothing nests the
          // two the other way around anymore.
          const wrote = await withWorkspaceWriteLock(row.workspaceId, async () => {
            const workspaceDoc = await getWorkspaceDoc(row.workspaceId)
            if (resolveWorkspaceDocumentById(workspaceDoc, documentId) === null) {
              createWorkspaceDocumentAtPath(workspaceDoc, {
                path: row.path,
                documentId,
                kind,
              })
            }
            // MERGE into the cached projection — the doc instance
            // loadSnapshot serves and every route save mutates — rather
            // than diff-writing the tool's own copy over the tree. A tool
            // that loaded before a concurrent route write then converges
            // with it (import is a CRDT merge; ops the projection already
            // has are no-ops) instead of value-diffing the other writer's
            // edit back out.
            const live = await getDoc(row.workspaceId, row.path)
            live.import(doc.export({ mode: 'update' }))
            if (!writeWorkspaceDocumentContent(workspaceDoc, documentId, live)) return false
            await saveWorkspaceDoc(row.workspaceId, workspaceDoc)
            return true
          })
          if (wrote) return
        }
      }
    }
    return this.inner.saveSnapshot(input)
  }

  async saveCompactedSnapshot(input: SaveCompactedSnapshotInput): Promise<void> {
    // Compaction is a legacy-plane concern: a tree-served document has no
    // per-document log to fold. Delegated as-is.
    return this.inner.saveCompactedSnapshot(input)
  }

  async appendDeltas(input: AppendDeltasInput): Promise<AppendDeltasResult> {
    return this.inner.appendDeltas(input)
  }

  async loadDeltas(input: LoadDeltasInput): Promise<LoadDeltasResult> {
    return this.inner.loadDeltas(input)
  }

  async readFrontier(input: ReadFrontierInput): Promise<ReadFrontierResult> {
    return this.inner.readFrontier(input)
  }

  async deleteDoc(input: DeleteDocInput): Promise<void> {
    return this.inner.deleteDoc(input)
  }
}

/**
 * `DocumentIndex` that keeps the `documents` table authoritative for reads
 * (listing order, the fold's work list, versions/branches joins) while
 * mirroring every MUTATION into the workspace tree — through the shared
 * live workspace doc, so the content plane and this metadata plane cannot
 * drift apart within one process.
 */
export class DualPlaneDocumentIndex implements DocumentIndex {
  constructor(
    private readonly rows: DocumentIndex,
    readonly _db: Kysely<DatabaseSchema>,
  ) {}

  #treeIndex(): LoroWorkspaceDocumentIndex {
    return new LoroWorkspaceDocumentIndex(cacheBackedWorkspaceDocs(), new FsBlobStore(getDataDir()))
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<void> {
    return this.rows.createWorkspace(input)
  }

  async createDocument(input: CreateDocumentInput): Promise<DocumentEntry> {
    const entry = await this.rows.createDocument(input)
    const workspaceDoc = await getWorkspaceDoc(input.workspaceId)
    createWorkspaceDocumentAtPath(workspaceDoc, {
      path: entry.path,
      documentId: entry.documentId,
      kind: input.kind,
      ...(entry.name === undefined ? {} : { name: entry.name }),
    })
    await saveWorkspaceDoc(input.workspaceId, workspaceDoc)
    return entry
  }

  async resolveDocument(input: ResolveDocumentInput): Promise<DocumentEntry | null> {
    return this.rows.resolveDocument(input)
  }

  async resolveDocumentById(input: ResolveDocumentByIdInput): Promise<DocumentEntry | null> {
    return this.rows.resolveDocumentById(input)
  }

  async listDocuments(input: ListDocumentsInput): Promise<DocumentEntry[]> {
    return this.rows.listDocuments(input)
  }

  async moveDocument(input: MoveDocumentInput): Promise<void> {
    await this.rows.moveDocument(input)
    const workspaceDoc = await openWorkspaceDocIfStored(input.workspaceId)
    if (workspaceDoc !== null) {
      moveWorkspaceNodeToPath(workspaceDoc, input.from, input.to)
      await saveWorkspaceDoc(input.workspaceId, workspaceDoc)
    }
    // Both path keys: a cached doc under the old path would serve a path
    // that no longer exists, and one under the new path predates the move.
    evictDoc(input.workspaceId, input.from)
    evictDoc(input.workspaceId, input.to)
  }

  async setDocumentName(input: SetDocumentNameInput): Promise<void> {
    await this.rows.setDocumentName(input)
    const workspaceDoc = await openWorkspaceDocIfStored(input.workspaceId)
    if (
      workspaceDoc !== null &&
      resolveWorkspaceDocumentById(workspaceDoc, input.documentId) !== null
    ) {
      setWorkspaceDocumentName(workspaceDoc, {
        documentId: input.documentId,
        ...(input.name === undefined ? {} : { name: input.name }),
      })
      await saveWorkspaceDoc(input.workspaceId, workspaceDoc)
    }
  }

  async deleteDocument(input: DeleteDocumentInput): Promise<void> {
    // Tree first, because its delete EVACUATES: if the export or blob write
    // fails, both planes still hold the document and the caller can retry.
    const workspaceDoc = await openWorkspaceDocIfStored(input.workspaceId)
    if (workspaceDoc !== null) {
      const entry = await this.rows.resolveDocument(input)
      if (entry !== null && resolveWorkspaceDocumentById(workspaceDoc, entry.documentId) !== null) {
        await this.#treeIndex().deleteDocument(input)
      }
    }
    await this.rows.deleteDocument(input)
    evictDoc(input.workspaceId, input.path)
  }
}
