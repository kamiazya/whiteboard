import type { WorkspaceId } from '@kamiazya/whiteboard-canvas-model'
import type { CanvasDocStore } from '@kamiazya/whiteboard-canvas-ports'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import { WorkspaceTree } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import { CanvasNotFoundError } from './canvas-crud.errors.js'

// Cloudflare Durable Objects cap inbound/outbound WebSocket messages at
// roughly 2MB; 1MB leaves headroom for the manifest+chunk plumbing around
// the raw bytes. This constant lives here (a composition-root-facing tool),
// not in canvas-ports, per that package's rule that chunk-size caps are
// always a caller-supplied parameter.
const MAX_CHUNK_BYTES = 1_000_000

/**
 * Loads the workspace-tree LoroDoc for `workspaceId` from `canvasDocStore`.
 * A workspace with no persisted tree yet (first access) resolves to an
 * empty `WorkspaceTree` rather than throwing.
 */
export async function loadWorkspaceTree(
  canvasDocStore: CanvasDocStore,
  workspaceId: WorkspaceId,
): Promise<WorkspaceTree> {
  return (
    (await loadWorkspaceTreeIfExists(canvasDocStore, workspaceId)) ??
    new WorkspaceTree(new LoroDoc())
  )
}

/**
 * Like `loadWorkspaceTree`, but resolves to `null` for a workspace with no
 * persisted tree — the existence signal `wbCanvasCreate` uses to refuse
 * materializing a workspace nobody explicitly asked for.
 */
export async function loadWorkspaceTreeIfExists(
  canvasDocStore: CanvasDocStore,
  workspaceId: WorkspaceId,
): Promise<WorkspaceTree | null> {
  const result = await canvasDocStore.loadSnapshot({
    docRef: { kind: 'workspace-tree', workspaceId },
  })
  if (result === null) return null
  const bytes = reassembleSnapshot(result.manifest, result.chunks)
  return WorkspaceTree.fromSnapshot(bytes)
}

/**
 * Guards a mutation tool against a caller-supplied `workspaceId` that does
 * not actually own `canvasId` (stale cached id, copy-paste across two open
 * canvases, client bug). Without this check a mismatched pair would still
 * pass every canvas-doc-level validation — `loadCanvasDoc`/
 * `loadOrCreateCanvasDoc` address the doc purely by `canvasId` — and the
 * only symptom would be a silently stale `WorkspaceIndex` for the real
 * workspace, since `reindexWorkspace` fails open and only logs. Call this
 * before any mutation so the caller gets an explicit, typed rejection
 * instead of a hard-to-detect index-staleness bug.
 */
export async function assertCanvasInWorkspace(
  canvasDocStore: CanvasDocStore,
  workspaceId: WorkspaceId,
  canvasId: string,
): Promise<void> {
  const tree = await loadWorkspaceTree(canvasDocStore, workspaceId)
  const exists = tree.snapshot().nodes.some((node) => node.canvasId === canvasId)
  if (!exists) throw new CanvasNotFoundError(workspaceId, canvasId)
}

/**
 * Persists `tree` back to `canvasDocStore` for `workspaceId`.
 *
 * Known limitation: this is a read-modify-write over the same document with
 * no optimistic-concurrency check against the frontier read at load time.
 * Two concurrent requests against the same workspace can race and the
 * later save wins, silently discarding the earlier mutation. Accepted for
 * this slice; revisit with a frontier-compare-before-save guard once
 * multi-request concurrency on a single workspace is a real deployment
 * shape.
 */
export async function saveWorkspaceTree(
  canvasDocStore: CanvasDocStore,
  workspaceId: WorkspaceId,
  tree: WorkspaceTree,
): Promise<void> {
  const bytes = tree.exportSnapshot()
  const { manifest, chunks } = chunkSnapshot(bytes, MAX_CHUNK_BYTES)
  const frontier = tree.exportFrontier()
  await canvasDocStore.saveSnapshot({
    docRef: { kind: 'workspace-tree', workspaceId },
    manifest,
    chunks,
    frontier,
  })
}
