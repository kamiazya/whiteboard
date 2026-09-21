/**
 * wb_document_get's OKF export's input and output contracts, and nothing else.
 *
 * Schemas only, so `../contracts.ts` can publish them to a BROWSER without
 * the tool's own graph coming with them. See that file for why the split
 * exists rather than being a matter of taste.
 */
import { okfMarkdownFrontmatterSchema } from '@kamiazya/whiteboard-codec'
import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'

export const exportOkfInputSchema = z
  .object({ workspaceId: workspaceIdSchema, documentId: documentIdSchema })
  .strict()
export type ExportOkfInput = z.infer<typeof exportOkfInputSchema>

/**
 * `body` repeats bytes `markdown` already carries, and that is the point:
 * the two answer different questions. `markdown` is the OKF projection —
 * what a file of this document would contain. `body` is what a renderer
 * draws, and every caller that wants it either re-parses the serialization
 * this function built from a body it had in hand, or forgets to and draws
 * the frontmatter block as prose.
 */
export const exportOkfOutputSchema = z
  .object({ markdown: z.string(), body: z.string(), frontmatter: okfMarkdownFrontmatterSchema })
  .strict()
export type ExportOkfOutput = z.infer<typeof exportOkfOutputSchema>
