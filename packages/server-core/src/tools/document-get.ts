import { okfMarkdownFrontmatterSchema } from '@kamiazya/whiteboard-canvas-codec'
import {
  canvasIdSchema,
  canvasKindSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-canvas-model'
import { readDocumentKind } from '@kamiazya/whiteboard-canvas-workspace'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { loadOrCreateCanvasDoc } from './canvas-doc-io.js'
import { createCanvasExportJsonCanvasTool } from './canvas-export-json-canvas.js'
import { createCanvasExportOkfTool } from './canvas-export-okf.js'

const documentGetInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    canvasId: canvasIdSchema,
    options: z
      .object({
        strict: z
          .boolean()
          .default(false)
          .describe(
            'JSON Canvas only: drop the x-whiteboard extension so the output is plain JSON Canvas 1.0.',
          ),
      })
      .strict()
      .optional(),
  })
  .strict()
export type DocumentGetInput = z.infer<typeof documentGetInputSchema>

const documentGetOutputSchema = z
  .object({
    kind: canvasKindSchema,
    content: z.string(),
    // Present only for a markdown document. Frontmatter is OKF's, and a JSON
    // Canvas document has none (ADR-0009 decision 3) — an always-present
    // field would have to invent one.
    frontmatter: okfMarkdownFrontmatterSchema.optional(),
  })
  .strict()
export type DocumentGetOutput = z.infer<typeof documentGetOutputSchema>

export class DocumentKindUnknownError extends Error {
  constructor(public readonly canvasId: string) {
    super(
      `Document ${canvasId} records no kind, so there is no format to read it as. ` +
        'Documents created before kinds existed are affected; recreate it, or set its content ' +
        'through wb_document_set, which writes a kind.',
    )
    this.name = 'DocumentKindUnknownError'
  }
}

/**
 * The read half of ADR-0009 decision 4: the format follows from the document.
 *
 * This replaces the two exporters it now calls. They both ran on ANY
 * document — the OKF one filling in a placeholder `type` for documents that
 * had never carried frontmatter — so a caller could ask a diagram for its
 * markdown and get something back. Which format you get is now the
 * document's answer, not the caller's.
 */
export function createDocumentGetTool(deps: ServerDeps) {
  return {
    name: 'wb_document_get' as const,
    description:
      'Read a document in its own format: a markdown document as OKF Markdown, a spatial one as JSON Canvas. The format is not a parameter — it follows from what the document was created as, and `kind` in the result says which you got.',
    inputSchema: documentGetInputSchema,
    outputSchema: documentGetOutputSchema,
    async execute(input: DocumentGetInput): Promise<DocumentGetOutput> {
      const doc = await loadOrCreateCanvasDoc(deps, input.canvasId)
      const kind = readDocumentKind(doc)
      if (kind === undefined) {
        throw new DocumentKindUnknownError(input.canvasId)
      }
      if (kind === 'markdown') {
        const { markdown, frontmatter } = await createCanvasExportOkfTool(deps).execute({
          workspaceId: input.workspaceId,
          canvasId: input.canvasId,
        })
        return { kind, content: markdown, frontmatter }
      }
      const { json } = await createCanvasExportJsonCanvasTool(deps).execute({
        workspaceId: input.workspaceId,
        canvasId: input.canvasId,
        ...(input.options ? { options: input.options } : {}),
      })
      return { kind, content: json }
    },
  }
}
