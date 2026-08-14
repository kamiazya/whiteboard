import { parseOkf } from '@kamiazya/whiteboard-canvas-codec'
import { canvasIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-canvas-model'
import {
  readDocumentKind,
  writeCoreFacets,
  writeDocumentKind,
  writeFacets,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-canvas-workspace'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateCanvasDoc, saveDocSnapshot } from './canvas-doc-io.js'
import { assertCanvasInWorkspace } from './workspace-tree-io.js'

const TEXT_NODE_ID = 'okf-body'

export const canvasImportOkfInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasId: canvasIdSchema,
    markdown: z.string(),
  })
  .strict()
export type CanvasImportOkfInput = z.infer<typeof canvasImportOkfInputSchema>

export const canvasImportOkfOutputSchema = z
  .object({
    canvasId: canvasIdSchema,
    imported: z.literal(true),
  })
  .strict()
export type CanvasImportOkfOutput = z.infer<typeof canvasImportOkfOutputSchema>

export class DocumentKindMismatchError extends Error {
  constructor(
    public readonly canvasId: string,
    public readonly kind: string,
  ) {
    super(
      `Document ${canvasId} is a ${kind} document, and this writes OKF Markdown. ` +
        'Its nodes and edges would be replaced by a single text node. Edit a spatial ' +
        'document through wb_node_patch / wb_edge_patch instead.',
    )
    this.name = 'DocumentKindMismatchError'
  }
}

export class OkfParseError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
  ) {
    super(`OKF parse failed at ${stage}: ${message}`)
    this.name = 'OkfParseError'
  }
}

export function createCanvasImportOkfTool(deps: ServerDeps) {
  return {
    name: 'wb_document_set' as const,
    description:
      'Replace the entire content of an existing document from an OKF Markdown string. The document must already exist; core facets, extension facets and the body are all overwritten rather than merged.',
    inputSchema: canvasImportOkfInputSchema,
    outputSchema: canvasImportOkfOutputSchema,
    execute: async (input: CanvasImportOkfInput): Promise<CanvasImportOkfOutput> => {
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
      // and refusing would leave it with no way back (ADR-0009 decision 4).
      const kind = readDocumentKind(doc)
      if (kind !== undefined && kind !== 'markdown') {
        throw new DocumentKindMismatchError(input.canvasId, kind)
      }
      writeDocumentKind(doc, 'markdown')

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
