import {
  canvasColorSchema,
  canvasEdgeSchema,
  canvasIdSchema,
  nodeIdSchema,
  spatialCanvasSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-canvas-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadCanvasDoc, saveCanvasDoc } from './canvas-doc-io.js'
import { EdgeNotFoundError, PatchValidationError } from './errors.js'
import { withReindex } from './with-reindex.js'
import { assertCanvasInWorkspace } from './workspace-tree-io.js'

export const edgePatchFieldsSchema = z
  .object({
    fromNode: nodeIdSchema.optional(),
    toNode: nodeIdSchema.optional(),
    fromSide: z.enum(['top', 'right', 'bottom', 'left']).optional(),
    toSide: z.enum(['top', 'right', 'bottom', 'left']).optional(),
    fromEnd: z.enum(['none', 'arrow']).optional(),
    toEnd: z.enum(['none', 'arrow']).optional(),
    color: canvasColorSchema.optional(),
    label: z.string().optional(),
  })
  .strict()
export type EdgePatchFields = z.infer<typeof edgePatchFieldsSchema>

export const edgePatchInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasId: canvasIdSchema,
    // canvas-model has no distinct edgeIdSchema — edges and nodes share
    // the same nanoid-style id shape (`nodeIdSchema` only enforces
    // non-emptiness), so reusing it here is deliberate, not a copy-paste
    // mistake.
    edgeId: nodeIdSchema,
    patch: edgePatchFieldsSchema,
  })
  .strict()
export type EdgePatchInput = z.infer<typeof edgePatchInputSchema>

export const edgePatchOutputSchema = z
  .object({
    canvasId: canvasIdSchema,
    edge: canvasEdgeSchema,
  })
  .strict()
export type EdgePatchOutput = z.infer<typeof edgePatchOutputSchema>

export function createEdgePatchTool(deps: ServerDeps) {
  return {
    name: 'edge_patch' as const,
    inputSchema: edgePatchInputSchema,
    outputSchema: edgePatchOutputSchema,
    execute: withReindex(deps, async (input: EdgePatchInput): Promise<EdgePatchOutput> => {
      await assertCanvasInWorkspace(deps.canvasDocStore, input.workspaceId, input.canvasId)
      const { doc, canvas } = await loadCanvasDoc(deps, input.canvasId)

      const edge = canvas.edges.find((candidate) => candidate.id === input.edgeId)
      if (edge === undefined) throw new EdgeNotFoundError(input.canvasId, input.edgeId)

      const mergedRaw = { ...edge, ...input.patch }
      const candidateCanvas = {
        nodes: canvas.nodes,
        edges: canvas.edges.map((existing) =>
          existing.id === input.edgeId ? mergedRaw : existing,
        ),
      }

      // `spatialCanvasSchema` (not `canvasEdgeSchema`) is the validation
      // gate here: it is the only schema that owns the endpoint-existence
      // invariant, so a retargeted fromNode/toNode pointing at a
      // nonexistent node id surfaces as a PatchValidationError.
      const parsed = spatialCanvasSchema.safeParse(candidateCanvas)
      if (!parsed.success) throw new PatchValidationError(parsed.error.issues)

      const updatedEdge = parsed.data.edges.find((existing) => existing.id === input.edgeId)
      if (updatedEdge === undefined) {
        throw new EdgeNotFoundError(input.canvasId, input.edgeId)
      }

      await saveCanvasDoc(deps, input.canvasId, doc, parsed.data)

      return { canvasId: input.canvasId, edge: updatedEdge }
    }),
  }
}
