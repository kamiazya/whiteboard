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

function docRefKey(docRef: DocRef): string {
  return docRef.kind === 'canvas'
    ? `canvas:${docRef.documentId}`
    : `workspace-tree:${docRef.workspaceId}`
}

/**
 * Minimal in-memory `DocumentStore` test double: snapshot-only, keyed by
 * `DocRef`. Delta append/load are unimplemented (unused by the canvas-CRUD
 * tools under test) and throw if called, so a test that accidentally
 * exercises them fails loudly instead of silently no-oping.
 */
export function createInMemoryDocumentStore(): DocumentStore {
  const snapshots = new Map<string, { manifest: unknown; chunks: unknown[]; frontier: unknown }>()

  return {
    async loadSnapshot(input: LoadSnapshotInput): Promise<LoadSnapshotResult> {
      const stored = snapshots.get(docRefKey(input.docRef))
      if (!stored) return null
      return structuredClone(stored) as LoadSnapshotResult
    },
    async saveSnapshot(input: SaveSnapshotInput): Promise<void> {
      const { docRef, manifest, chunks, frontier } = input
      snapshots.set(docRefKey(docRef), structuredClone({ manifest, chunks, frontier }))
    },
    async appendDeltas(_input: AppendDeltasInput): Promise<AppendDeltasResult> {
      throw new Error('appendDeltas is not supported by createInMemoryDocumentStore')
    },
    async loadDeltas(_input: LoadDeltasInput): Promise<LoadDeltasResult> {
      throw new Error('loadDeltas is not supported by createInMemoryDocumentStore')
    },
    async readFrontier(_input: ReadFrontierInput): Promise<ReadFrontierResult> {
      const stored = snapshots.get(docRefKey(_input.docRef))
      if (!stored) return null
      return { frontier: structuredClone(stored.frontier) } as ReadFrontierResult
    },
    async deleteDoc(input: DeleteDocInput): Promise<void> {
      snapshots.delete(docRefKey(input.docRef))
    },
  }
}
