import { readNodeLocks } from '@kamiazya/whiteboard-loro-adapter'
import {
  canvasColorSchema,
  documentIdSchema,
  nodeIdSchema,
  spatialCanvasSchema,
  spatialNodeSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'
import { loadDocument, saveDocumentBodySnapshot } from './document-io.js'
import { NodeLockedError, NodeNotFoundError, PatchValidationError } from './errors.js'

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
    documentId: documentIdSchema,
    nodeId: nodeIdSchema,
    patch: nodePatchFieldsSchema,
  })
  .strict()
export type NodePatchInput = z.infer<typeof nodePatchInputSchema>

export const nodePatchOutputSchema = z
  .object({
    documentId: documentIdSchema,
    node: spatialNodeSchema,
  })
  .strict()
export type NodePatchOutput = z.infer<typeof nodePatchOutputSchema>

export function createNodePatchTool(deps: ServerDeps) {
  return {
    name: 'wb_node_patch' as const,
    description:
      'Update the geometry or style of a node already on the spatial canvas. Fails if the node does not exist — use wb_node_add to create one.',
    inputSchema: nodePatchInputSchema,
    outputSchema: nodePatchOutputSchema,
    execute: async (input: NodePatchInput): Promise<NodePatchOutput> => {
      await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)
      const { doc, canvas } = await loadDocument(deps, input.documentId)

      const node = canvas.nodes.find((candidate) => candidate.id === input.nodeId)
      if (node === undefined) throw new NodeNotFoundError(input.documentId, input.nodeId)
      // The lock binds agents too — refuse BEFORE any write so a rejected
      // patch leaves the doc byte-identical.
      if (readNodeLocks(doc).has(input.nodeId)) {
        throw new NodeLockedError(input.documentId, input.nodeId)
      }

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
        throw new NodeNotFoundError(input.documentId, input.nodeId)
      }

      await saveDocumentBodySnapshot(deps, input.documentId, doc, parsed.data)

      return { documentId: input.documentId, node: updatedNode }
    },
  }
}
