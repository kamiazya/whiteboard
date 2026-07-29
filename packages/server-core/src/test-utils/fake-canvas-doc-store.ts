import type { CanvasId, WorkspaceId } from '@kamiazya/whiteboard-canvas-model'
import type {
  AppendDeltasInput,
  AppendDeltasResult,
  CanvasDocStore,
  DocRef,
  LoadDeltasInput,
  LoadDeltasResult,
  LoadSnapshotInput,
  LoadSnapshotResult,
  ReadFrontierInput,
  ReadFrontierResult,
  SaveSnapshotInput,
} from '@kamiazya/whiteboard-canvas-ports'
import { chunkSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { WorkspaceTree } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'

const SNAPSHOT_MAX_CHUNK_BYTES = 1_000_000

function docRefKey(docRef: DocRef): string {
  return docRef.kind === 'canvas'
    ? `canvas:${docRef.canvasId}`
    : `workspace-tree:${docRef.workspaceId}`
}

/**
 * An in-memory CanvasDocStore fake shared across server-core tool tests.
 * Keyed by `docRef` (canvas OR workspace-tree) so a single fake instance
 * backs both a mutation tool's canvas doc and the workspace-tree reindex
 * reads that a mutation now triggers, matching how a real store scopes
 * storage by DocRef rather than by store instance.
 */
export class FakeCanvasDocStore implements CanvasDocStore {
  private readonly saved = new Map<string, SaveSnapshotInput>()

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
}

/**
 * Configures a `LoroDoc` via `configure`, then snapshots it into the
 * given `FakeCanvasDocStore` under the provided `canvasId`.
 */
export async function seedDoc(
  store: FakeCanvasDocStore,
  canvasId: CanvasId,
  configure: (doc: LoroDoc) => void,
): Promise<void> {
  const doc = new LoroDoc()
  configure(doc)
  const { manifest, chunks } = chunkSnapshot(
    doc.export({ mode: 'snapshot' }),
    SNAPSHOT_MAX_CHUNK_BYTES,
  )
  await store.saveSnapshot({
    docRef: { kind: 'canvas', canvasId },
    manifest,
    chunks,
    frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}

/**
 * Registers `canvasId` under `workspaceId`'s workspace tree so
 * `assertCanvasInWorkspace` (the workspace-ownership guard every mutation
 * tool runs before touching a canvas doc) accepts the pair. Tool tests that
 * seed a canvas doc directly via `seedDoc`/`seedCanvas` — bypassing
 * `wbCanvasCreate` — need this to keep exercising the "known, owned canvas"
 * path rather than tripping the ownership guard by accident.
 */
export async function registerCanvasInWorkspace(
  store: FakeCanvasDocStore,
  workspaceId: WorkspaceId,
  canvasId: CanvasId,
  segment = 'doc',
): Promise<void> {
  const tree = new WorkspaceTree(new LoroDoc())
  tree.createNode(canvasId, segment)
  const bytes = tree.exportSnapshot()
  const { manifest, chunks } = chunkSnapshot(bytes, SNAPSHOT_MAX_CHUNK_BYTES)
  await store.saveSnapshot({
    docRef: { kind: 'workspace-tree', workspaceId },
    manifest,
    chunks,
    frontier: tree.exportFrontier(),
  })
}
