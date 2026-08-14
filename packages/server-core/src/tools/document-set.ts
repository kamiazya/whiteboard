import { parseOkf } from '@kamiazya/whiteboard-canvas-codec'
import { canvasIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import {
  readDocumentKind,
  readSpatialCanvas,
  writeCoreFacets,
  writeDocumentKind,
  writeFacets,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-canvas-workspace'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateCanvasDoc, saveDocSnapshot } from './canvas-doc-io.js'
import { DocumentContentLossError, DocumentKindMismatchError } from './errors.js'
import { assertCanvasInWorkspace } from './workspace-tree-io.js'

const TEXT_NODE_ID = 'okf-body'

export const documentSetInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasId: canvasIdSchema,
    markdown: z.string(),
  })
  .strict()
export type DocumentSetInput = z.infer<typeof documentSetInputSchema>

export const documentSetOutputSchema = z
  .object({
    canvasId: canvasIdSchema,
    imported: z.literal(true),
  })
  .strict()
export type DocumentSetOutput = z.infer<typeof documentSetOutputSchema>

export class OkfParseError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
  ) {
    super(`OKF parse failed at ${stage}: ${message}`)
    this.name = 'OkfParseError'
  }
}

export function createDocumentSetTool(deps: ServerDeps) {
  return {
    name: 'wb_document_set' as const,
    description:
      'Replace the entire content of an existing document from an OKF Markdown string. The document must already exist; core facets, extension facets and the body are all overwritten rather than merged.',
    inputSchema: documentSetInputSchema,
    outputSchema: documentSetOutputSchema,
    execute: async (input: DocumentSetInput): Promise<DocumentSetOutput> => {
      await assertCanvasInWorkspace(deps.canvasDocStore, input.workspaceId, input.canvasId)

      const parsed = parseOkf(input.markdown)
      if (!parsed.ok) {
        throw new OkfParseError(parsed.error.stage, parsed.error.message)
      }

      const { frontmatter, body } = parsed.value
      const doc = await loadOrCreateCanvasDoc(deps, input.canvasId)

      // The write below replaces the whole spatial canvas, so on a spatial
      // document it is a destruction rather than an edit. A document with no
      // kind predates them: the write is the only thing that can give it one,
      // and refusing would leave it with no way back (ADR-0009 decision 4) —
      // but only an empty document has nothing to lose by being declared
      // markdown. One that already holds a canvas gets its way back from the
      // spatial side, which declares a kind without discarding anything.
      const kind = readDocumentKind(doc)
      if (kind === undefined) {
        const existing = readSpatialCanvas(doc)
        if (existing.nodes.length > 0 || existing.edges.length > 0) {
          throw new DocumentContentLossError(
            input.canvasId,
            `It holds ${existing.nodes.length} node(s) and ${existing.edges.length} edge(s), which this write would replace with a single text node. ` +
              'Edit it through wb_node_add / wb_node_patch / wb_edge_patch, which records it as spatial and keeps them.',
          )
        }
        writeDocumentKind(doc, 'markdown')
      } else if (kind !== 'markdown') {
        throw new DocumentKindMismatchError(
          input.canvasId,
          kind,
          'This writes OKF Markdown, which would replace its nodes and edges with a single text node. Edit a spatial document through wb_node_add / wb_node_patch / wb_edge_patch instead.',
        )
      }

      const { facets, ...coreMeta } = frontmatter
      writeCoreFacets(doc, coreMeta)
      if (facets) {
        writeFacets(doc, facets)
      }

      const nodes =
        body.length > 0
          ? [
              {
                id: TEXT_NODE_ID,
                type: 'text' as const,
                x: 0,
                y: 0,
                width: 600,
                height: 400,
                text: body,
              },
            ]
          : []
      writeSpatialCanvas(doc, { nodes, edges: [] })

      await saveDocSnapshot(deps, input.canvasId, doc)

      return { canvasId: input.canvasId, imported: true }
    },
  }
}
