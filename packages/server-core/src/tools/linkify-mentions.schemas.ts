/**
 * wb_linkify_mentions's input and output contracts, and nothing else.
 *
 * Schemas only, so `../contracts.ts` can publish them to a BROWSER without
 * the tool's own graph coming with them. See that file for why the split
 * exists rather than being a matter of taste.
 */
import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'

export const linkifyMentionsInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    /** The SOURCE — the document whose prose gets rewritten. */
    documentId: documentIdSchema,
    /** The document the mentions name. */
    targetDocumentId: documentIdSchema,
  })
  .strict()
export type LinkifyMentionsInput = z.infer<typeof linkifyMentionsInputSchema>

export const linkifyMentionsOutputSchema = z
  .object({ linked: z.number().int().nonnegative() })
  .strict()
export type LinkifyMentionsOutput = z.infer<typeof linkifyMentionsOutputSchema>
