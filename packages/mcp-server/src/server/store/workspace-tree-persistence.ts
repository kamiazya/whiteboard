import type { CanvasDocStore, DocRef } from '@kamiazya/whiteboard-canvas-ports'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { WorkspaceTree } from '@kamiazya/whiteboard-canvas-workspace'

const DEFAULT_MAX_CHUNK_BYTES = 1024 * 1024

function workspaceTreeDocRef(workspaceId: string): DocRef {
  return { kind: 'workspace-tree', workspaceId }
}

export async function loadWorkspaceTree(
  store: CanvasDocStore,
  workspaceId: string,
): Promise<WorkspaceTree | null> {
  const docRef = workspaceTreeDocRef(workspaceId)
  const result = await store.loadSnapshot({ docRef })
  if (!result) return null

  const bytes = reassembleSnapshot(result.manifest, result.chunks)
  return WorkspaceTree.fromSnapshot(bytes)
}

export async function saveWorkspaceTree(
  store: CanvasDocStore,
  workspaceId: string,
  tree: WorkspaceTree,
  maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
): Promise<void> {
  const docRef = workspaceTreeDocRef(workspaceId)
  const snapshot = tree.exportSnapshot()
  const frontier = tree.exportFrontier()
  const { manifest, chunks } = chunkSnapshot(snapshot, maxChunkBytes)

  await store.saveSnapshot({ docRef, manifest, chunks, frontier })
}
