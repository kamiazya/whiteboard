import {
  canvasIdSchema,
  spatialCanvasSchema,
  spatialNodeSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-canvas-model'
import { readDocumentKind, writeDocumentKind } from '@kamiazya/whiteboard-canvas-workspace'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadCanvasDoc, saveCanvasDoc } from './canvas-doc-io.js'
import { DocumentKindMismatchError, PatchValidationError } from './errors.js'
import { assertCanvasInWorkspace } from './workspace-tree-io.js'

export const nodeAddInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasId: canvasIdSchema,
    node: spatialNodeSchema.describe(
      'The whole node, including the id you want it to have. Ids are yours to choose so an edge can refer to one before the other end exists.',
    ),
  })
  .strict()
export type NodeAddInput = z.infer<typeof nodeAddInputSchema>

export const nodeAddOutputSchema = z
  .object({
    canvasId: canvasIdSchema,
    node: spatialNodeSchema,
  })
  .strict()
export type NodeAddOutput = z.infer<typeof nodeAddOutputSchema>

export class NodeAlreadyExistsError extends Error {
  constructor(
    public readonly canvasId: string,
    public readonly nodeId: string,
  ) {
    super(
      `Node ${nodeId} already exists on canvas ${canvasId}. ` +
        'Use wb_node_patch to change it, or add it under a different id.',
    )
    this.name = 'NodeAlreadyExistsError'
  }
}

/**
 * The one MCP path that puts a node on a spatial canvas. wb_node_patch only
 * updates a node that is already there, so without this the sole way to
 * create one was the OKF write's side effect — a single text node with a
 * fixed id, replacing everything else on the canvas.
 */
export function createNodeAddTool(deps: ServerDeps) {
  return {
    name: 'wb_node_add' as const,
    description:
      'Add a node to a spatial canvas, keeping the nodes already on it. Fails if the id is taken — this never overwrites an existing node.',
    inputSchema: nodeAddInputSchema,
    outputSchema: nodeAddOutputSchema,
    execute: async (input: NodeAddInput): Promise<NodeAddOutput> => {
      await assertCanvasInWorkspace(deps.canvasDocStore, input.workspaceId, input.canvasId)
      const { doc, canvas } = await loadCanvasDoc(deps, input.canvasId)

      // A markdown document keeps its OKF body in a text node, so a node
      // added beside it is content no OKF projection can represent. A
      // document with no kind predates them and this write declares it, the
      // same way an OKF write declares a markdown one.
      const kind = readDocumentKind(doc)
      if (kind === undefined) {
        writeDocumentKind(doc, 'spatial')
      } else if (kind !== 'spatial') {
        throw new DocumentKindMismatchError(
          input.canvasId,
          kind,
          'This adds a JSON Canvas node, and its only node holds its OKF body. Write its content through wb_document_set, or its body through wb_body_patch.',
        )
      }

      if (canvas.nodes.some((existing) => existing.id === input.node.id)) {
        throw new NodeAlreadyExistsError(input.canvasId, input.node.id)
      }

      const parsed = spatialCanvasSchema.safeParse({
        nodes: [...canvas.nodes, input.node],
        edges: canvas.edges,
      })
      if (!parsed.success) throw new PatchValidationError(parsed.error.issues)

      await saveCanvasDoc(deps, input.canvasId, doc, parsed.data)

      return { canvasId: input.canvasId, node: input.node }
    },
  }
}
