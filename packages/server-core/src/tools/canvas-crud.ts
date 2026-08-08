import { WorkspaceTree } from '@kamiazya/whiteboard-canvas-workspace'
import { LoroDoc, type TreeID } from 'loro-crdt'
import type { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import {
  CanvasNotFoundError,
  CanvasParentNotFoundError,
  CanvasSegmentConflictError,
  WorkspaceNotFoundError,
} from './canvas-crud.errors.js'
import type {
  createCanvasInputSchema,
  createCanvasOutputSchema,
  deleteCanvasInputSchema,
  deleteCanvasOutputSchema,
  getCanvasInputSchema,
  getCanvasOutputSchema,
  listCanvasesInputSchema,
  listCanvasesOutputSchema,
} from './canvas-crud.schemas.js'
import { generateCanvasId } from './generate-canvas-id.js'
import { withReindex } from './with-reindex.js'
import {
  loadWorkspaceTree,
  loadWorkspaceTreeIfExists,
  saveWorkspaceTree,
} from './workspace-tree-io.js'

/**
 * Finds the tree node whose `canvasId` matches, or throws
 * `CanvasNotFoundError`. Shared by get/delete handlers.
 */
function findNodeOrThrow(tree: WorkspaceTree, workspaceId: string, canvasId: string) {
  const node = tree.snapshot().nodes.find((n) => n.canvasId === canvasId)
  if (!node) {
    throw new CanvasNotFoundError(workspaceId, canvasId)
  }
  return node
}

export async function wbCanvasCreate(
  deps: ServerDeps,
  input: z.infer<typeof createCanvasInputSchema>,
): Promise<z.infer<typeof createCanvasOutputSchema>> {
  return withReindex(deps, async (input: z.infer<typeof createCanvasInputSchema>) => {
    // Workspaces never materialize implicitly: a typo'd or hallucinated
    // workspaceId must fail loudly rather than silently writing data into a
    // workspace nobody asked for. `createWorkspace: true` is the explicit
    // opt-in that bootstraps a genuinely new workspace.
    const existingTree = await loadWorkspaceTreeIfExists(deps.canvasDocStore, input.workspaceId)
    if (existingTree === null && input.createWorkspace !== true) {
      throw new WorkspaceNotFoundError(input.workspaceId)
    }
    const tree = existingTree ?? new WorkspaceTree(new LoroDoc())

    const parentId = input.parentId as TreeID | undefined
    if (parentId !== undefined && tree.getNode(parentId) === undefined) {
      throw new CanvasParentNotFoundError(input.parentId as string)
    }

    const conflict = tree.children(parentId).find((sibling) => sibling.segment === input.segment)
    if (conflict) {
      throw new CanvasSegmentConflictError(input.segment)
    }

    const canvasId = generateCanvasId()
    tree.createNode(canvasId, input.segment, parentId)
    await saveWorkspaceTree(deps.canvasDocStore, input.workspaceId, tree)

    return { canvasId, segment: input.segment }
  })(input)
}

export async function wbCanvasGet(
  deps: ServerDeps,
  input: z.infer<typeof getCanvasInputSchema>,
): Promise<z.infer<typeof getCanvasOutputSchema>> {
  const tree = await loadWorkspaceTree(deps.canvasDocStore, input.workspaceId)
  const node = findNodeOrThrow(tree, input.workspaceId, input.canvasId)
  const alias = tree.resolveAlias(node.id)
  return { canvasId: node.canvasId, segment: node.segment, alias: alias ?? node.segment }
}

export async function wbCanvasList(
  deps: ServerDeps,
  input: z.infer<typeof listCanvasesInputSchema>,
): Promise<z.infer<typeof listCanvasesOutputSchema>> {
  const tree = await loadWorkspaceTree(deps.canvasDocStore, input.workspaceId)
  return {
    canvases: tree.snapshot().nodes.map((node) => ({
      canvasId: node.canvasId,
      segment: node.segment,
      alias: tree.resolveAlias(node.id) ?? node.segment,
    })),
  }
}

export async function wbCanvasDelete(
  deps: ServerDeps,
  input: z.infer<typeof deleteCanvasInputSchema>,
): Promise<z.infer<typeof deleteCanvasOutputSchema>> {
  return withReindex(
    deps,
    async (
      input: z.infer<typeof deleteCanvasInputSchema>,
    ): Promise<z.infer<typeof deleteCanvasOutputSchema>> => {
      const tree = await loadWorkspaceTree(deps.canvasDocStore, input.workspaceId)
      const node = findNodeOrThrow(tree, input.workspaceId, input.canvasId)
      tree.delete(node.id)
      await saveWorkspaceTree(deps.canvasDocStore, input.workspaceId, tree)
      return { deleted: true }
    },
  )(input)
}
