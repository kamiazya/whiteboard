import {
  canvasEdgeSchema,
  canvasIdSchema,
  spatialCanvasSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-canvas-model'
import { readDocumentKind, writeDocumentKind } from '@kamiazya/whiteboard-canvas-workspace'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { assertCanvasInWorkspace } from './assert-canvas-in-workspace.js'
import { loadDocument, saveCanvasDoc } from './document-io.js'
import { DocumentKindMismatchError, PatchValidationError } from './errors.js'

export const edgeAddInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasId: canvasIdSchema,
    edge: canvasEdgeSchema.describe(
      'The whole edge, including the id you want it to have. Both endpoints must already be on the canvas.',
    ),
  })
  .strict()
export type EdgeAddInput = z.infer<typeof edgeAddInputSchema>

export const edgeAddOutputSchema = z
  .object({
    canvasId: canvasIdSchema,
    edge: canvasEdgeSchema,
  })
  .strict()
export type EdgeAddOutput = z.infer<typeof edgeAddOutputSchema>

export class EdgeAlreadyExistsError extends Error {
  constructor(
    public readonly canvasId: string,
    public readonly edgeId: string,
  ) {
    super(
      `Edge ${edgeId} already exists on canvas ${canvasId}. ` +
        'Use wb_edge_patch to change it, or add it under a different id.',
    )
    this.name = 'EdgeAlreadyExistsError'
  }
}

/**
 * The one MCP path that connects two nodes. wb_edge_patch only updates an
 * edge that is already there, so before this a caller could add nodes and
 * never join them.
 */
export function createEdgeAddTool(deps: ServerDeps) {
  return {
    name: 'wb_edge_add' as const,
    description:
      'Connect two nodes already on a spatial canvas, keeping the edges already there. Fails if the id is taken or an endpoint does not exist — this never overwrites an existing edge.',
    inputSchema: edgeAddInputSchema,
    outputSchema: edgeAddOutputSchema,
    execute: async (input: EdgeAddInput): Promise<EdgeAddOutput> => {
      await assertCanvasInWorkspace(deps.documentIndex, input.workspaceId, input.canvasId)
      const { doc, canvas } = await loadDocument(deps, input.canvasId)

      const kind = readDocumentKind(doc)
      if (kind === undefined) {
        writeDocumentKind(doc, 'spatial')
      } else if (kind !== 'spatial') {
        throw new DocumentKindMismatchError(
          input.canvasId,
          kind,
          'This adds a JSON Canvas edge, and its only node holds its OKF body. Write its content through wb_document_set, or its body through wb_body_patch.',
        )
      }

      if (canvas.edges.some((existing) => existing.id === input.edge.id)) {
        throw new EdgeAlreadyExistsError(input.canvasId, input.edge.id)
      }

      // `spatialCanvasSchema` (not `canvasEdgeSchema`) is the validation gate:
      // it is the only schema that owns the endpoint-existence invariant, so
      // an edge naming a node the canvas does not have surfaces here rather
      // than through a second check written by hand.
      const parsed = spatialCanvasSchema.safeParse({
        nodes: canvas.nodes,
        edges: [...canvas.edges, input.edge],
      })
      if (!parsed.success) throw new PatchValidationError(parsed.error.issues)

      await saveCanvasDoc(deps, input.canvasId, doc, parsed.data)

      return { canvasId: input.canvasId, edge: input.edge }
    },
  }
}
