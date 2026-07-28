import type { WorkspaceId } from '@kamiazya/whiteboard-canvas-model'
import { reassembleSnapshot } from '@kamiazya/whiteboard-canvas-ports'
import type { CanvasIndexInput } from '@kamiazya/whiteboard-canvas-workspace'
import { deriveWorkspaceIndexRows, readFacets } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc } from 'loro-crdt'
import type { ServerDeps } from '../server-deps.js'
import { loadWorkspaceTree } from './workspace-tree-io.js'

/**
 * Rebuilds `workspaceId`'s WorkspaceIndex rows from the current tree +
 * canvas docs. A tree node whose canvas has no saved snapshot yet (a
 * freshly created, still-empty canvas) is skipped — there is no doc to
 * derive facet/backlink rows from, so it only shows up via the tree
 * itself once a doc is saved.
 *
 * `coreFacets` (title/type/tags/view, sourced from OKF frontmatter) and
 * `resolvedBody` (backlinks, requiring the markdown resolve pipeline) are
 * not wired yet — this reindexes on tree membership + extension facets
 * only, matching what canvas docs persist today.
 */
export async function reindexWorkspace(deps: ServerDeps, workspaceId: WorkspaceId): Promise<void> {
  const tree = await loadWorkspaceTree(deps.canvasDocStore, workspaceId)

  const canvases: CanvasIndexInput[] = []
  for (const node of tree.snapshot().nodes) {
    const snapshot = await deps.canvasDocStore.loadSnapshot({
      docRef: { kind: 'canvas', canvasId: node.canvasId },
    })
    if (snapshot === null) continue

    const doc = new LoroDoc()
    doc.import(reassembleSnapshot(snapshot.manifest, snapshot.chunks))

    canvases.push({
      canvasId: node.canvasId,
      updatedAtMs: Date.now(),
      extensionFacets: readFacets(doc),
    })
  }

  const rows = deriveWorkspaceIndexRows({ workspaceId, tree, canvases })
  await deps.workspaceIndex.applyRows(rows)
}
