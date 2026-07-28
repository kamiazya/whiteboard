import type {
  AppendDeltasInput,
  AppendDeltasResult,
  CanvasDocStore,
  LoadDeltasInput,
  LoadDeltasResult,
  LoadSnapshotInput,
  LoadSnapshotResult,
  ReadFrontierInput,
  ReadFrontierResult,
  SaveSnapshotInput,
} from '@kamiazya/whiteboard-canvas-ports'

/**
 * An in-memory CanvasDocStore fake shared across server-core tool tests.
 * Keyed by `docRef.canvasId` so a single fake instance can back multiple
 * canvases within one test, matching how a real store scopes storage by
 * DocRef rather than by store instance.
 */
export class FakeCanvasDocStore implements CanvasDocStore {
  private readonly saved = new Map<string, SaveSnapshotInput>()

  async loadSnapshot(input: LoadSnapshotInput): Promise<LoadSnapshotResult> {
    if (input.docRef.kind !== 'canvas') throw new Error('fake store only supports canvas docs')
    const entry = this.saved.get(input.docRef.canvasId)
    if (entry === undefined) return null
    return { manifest: entry.manifest, chunks: entry.chunks, frontier: entry.frontier }
  }

  async saveSnapshot(input: SaveSnapshotInput): Promise<void> {
    if (input.docRef.kind !== 'canvas') throw new Error('fake store only supports canvas docs')
    this.saved.set(input.docRef.canvasId, input)
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
