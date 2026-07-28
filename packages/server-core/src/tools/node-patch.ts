import {
  canvasColorSchema,
  canvasIdSchema,
  nodeIdSchema,
  spatialCanvasSchema,
  spatialNodeSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-canvas-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadCanvasDoc, saveCanvasDoc } from './canvas-doc-io.js'
import { NodeNotFoundError, PatchValidationError } from './errors.js'
import { reindexWorkspace } from './reindex.js'

/**
 * Deliberately limited to the geometry/style fields every node type
 * shares plus `label` (which only `groupNodeSchema` declares) — not the
 * full per-type content field set (`text`/`file`/`subpath`/`url`/
 * `background`/`backgroundStyle`). Applying `label` to a non-group node
 * is a silent no-op after re-parse: `spatialNodeSchema`'s per-type
 * variants are not `.strict()`, so an unrecognized key is stripped, not
 * rejected. That is existing schema behavior, not new behavior introduced
 * here.
 */
export const nodePatchFieldsSchema = z
  .object({
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    width: z.number().int().nonnegative().optional(),
    height: z.number().int().nonnegative().optional(),
    color: canvasColorSchema.optional(),
    label: z.string().optional(),
  })
  .strict()
export type NodePatchFields = z.infer<typeof nodePatchFieldsSchema>

export const nodePatchInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasId: canvasIdSchema,
    nodeId: nodeIdSchema,
    patch: nodePatchFieldsSchema,
  })
  .strict()
export type NodePatchInput = z.infer<typeof nodePatchInputSchema>

export const nodePatchOutputSchema = z
  .object({
    canvasId: canvasIdSchema,
    node: spatialNodeSchema,
  })
  .strict()
export type NodePatchOutput = z.infer<typeof nodePatchOutputSchema>

export function createNodePatchTool(deps: ServerDeps) {
  return {
    name: 'node_patch' as const,
    inputSchema: nodePatchInputSchema,
    outputSchema: nodePatchOutputSchema,
    async execute(input: NodePatchInput): Promise<NodePatchOutput> {
      const { doc, canvas } = await loadCanvasDoc(deps, input.canvasId)

      const node = canvas.nodes.find((candidate) => candidate.id === input.nodeId)
      if (node === undefined) throw new NodeNotFoundError(input.canvasId, input.nodeId)

      const mergedRaw = { ...node, ...input.patch }
      const candidateCanvas = {
        nodes: canvas.nodes.map((existing) =>
          existing.id === input.nodeId ? mergedRaw : existing,
        ),
        edges: canvas.edges,
      }

      const parsed = spatialCanvasSchema.safeParse(candidateCanvas)
      if (!parsed.success) throw new PatchValidationError(parsed.error.issues)

      const updatedNode = parsed.data.nodes.find((existing) => existing.id === input.nodeId)
      if (updatedNode === undefined) {
        throw new NodeNotFoundError(input.canvasId, input.nodeId)
      }

      await saveCanvasDoc(deps, input.canvasId, doc, parsed.data)
      await reindexWorkspace(deps, input.workspaceId)

      return { canvasId: input.canvasId, node: updatedNode }
    },
  }
}
