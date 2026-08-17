import type { DocumentId, WorkspaceId } from '@kamiazya/whiteboard-model'
import type {
  AppendDeltasInput,
  AppendDeltasResult,
  DeleteDocInput,
  DocRef,
  DocumentStore,
  LoadDeltasInput,
  LoadDeltasResult,
  LoadSnapshotInput,
  LoadSnapshotResult,
  ReadFrontierInput,
  ReadFrontierResult,
  SaveSnapshotInput,
} from '@kamiazya/whiteboard-ports'
import { chunkSnapshot } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { LoroDoc } from 'loro-crdt'

const SNAPSHOT_MAX_CHUNK_BYTES = 1_000_000

function docRefKey(docRef: DocRef): string {
  return docRef.kind === 'document'
    ? `canvas:${docRef.documentId}`
    : `workspace-tree:${docRef.workspaceId}`
}

/**
 * An in-memory DocumentStore fake shared across server-core tool tests.
 * Keyed by `docRef` (canvas OR workspace-tree) so a single fake instance
 * backs both a mutation tool's canvas doc and the workspace-tree reindex
 * reads that a mutation now triggers, matching how a real store scopes
 * storage by DocRef rather than by store instance.
 */
export class FakeDocumentStore implements DocumentStore {
  private readonly saved = new Map<string, SaveSnapshotInput>()

  /**
   * The placement index that belongs with this store's documents. Carried
   * here rather than constructed per test so a test cannot register a
   * document in one index and have the tool read another — which is the
   * only way these two doubles can disagree.
   */
  readonly documentIndex = new InMemoryDocumentIndex()

  async loadSnapshot(input: LoadSnapshotInput): Promise<LoadSnapshotResult> {
    const entry = this.saved.get(docRefKey(input.docRef))
    if (entry === undefined) return null
    return { manifest: entry.manifest, chunks: entry.chunks, frontier: entry.frontier }
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<void> {
    this.saved.set(docRefKey(input.docRef), input)
  }

  async appendDeltas(_input: AppendDeltasInput): Promise<AppendDeltasResult> {
    throw new Error('not implemented')
  }

  async loadDeltas(_input: LoadDeltasInput): Promise<LoadDeltasResult> {
    throw new Error('not implemented')
  }

  async readFrontier(_input: ReadFrontierInput): Promise<ReadFrontierResult> {
    throw new Error('not implemented')
  }

  async deleteDoc(input: DeleteDocInput): Promise<void> {
    this.saved.delete(docRefKey(input.docRef))
  }
}

/**
 * Configures a `LoroDoc` via `configure`, then snapshots it into the
 * given `FakeDocumentStore` under the provided `documentId`.
 */
export async function seedDoc(
  store: FakeDocumentStore,
  documentId: DocumentId,
  configure: (doc: LoroDoc) => void,
): Promise<void> {
  const doc = new LoroDoc()
  configure(doc)
  const { manifest, chunks } = chunkSnapshot(
    doc.export({ mode: 'snapshot' }),
    SNAPSHOT_MAX_CHUNK_BYTES,
  )
  await store.saveSnapshot({
    docRef: { kind: 'document', documentId },
    manifest,
    chunks,
    frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}

/**
 * Registers `documentId` under `workspaceId`'s workspace tree so
 * `assertDocumentInWorkspace` (the workspace-ownership guard every mutation
 * tool runs before touching a canvas doc) accepts the pair. Tool tests that
 * seed a canvas doc directly via `seedDoc`/`seedCanvas` — bypassing
 * `wbDocumentCreate` — need this to keep exercising the "known, owned canvas"
 * path rather than tripping the ownership guard by accident.
 */
export async function registerDocumentInWorkspace(
  store: FakeDocumentStore,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  path = 'doc',
): Promise<void> {
  store.documentIndex.seed({ workspaceId, documentId, path, kind: 'spatial' })
}
