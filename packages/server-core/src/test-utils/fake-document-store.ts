import type { DocumentId, WorkspaceId } from '@kamiazya/whiteboard-model'
import { chunkSnapshot, DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex, InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { LoroDoc } from 'loro-crdt'

/**
 * The shared `InMemoryDocumentStore` plus the placement index that belongs
 * with its documents. A single instance backs both a mutation tool's canvas
 * doc and the workspace-tree reindex reads that a mutation triggers, matching
 * how a real store scopes storage by DocRef rather than by store instance.
 *
 * The index is carried here rather than constructed per test so a test cannot
 * register a document in one index and have the tool read another.
 */
export class FakeDocumentStore extends InMemoryDocumentStore {
  readonly documentIndex = new InMemoryDocumentIndex()
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
    DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES,
  )
  await store.saveSnapshot({
    // The stored key is derived from the documentId alone (see ports'
    // doc-ref-key.ts), so this seed workspaceId never has to match the
    // workspaceId a test's tool input names.
    docRef: { kind: 'document', workspaceId: 'seed-ws', documentId },
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
