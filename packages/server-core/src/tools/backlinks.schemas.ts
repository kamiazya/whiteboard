/**
 * wb_document_backlinks's input and output contracts, and nothing else.
 *
 * Schemas only, so `../contracts.ts` can publish them to a BROWSER without
 * the tool's own graph coming with them. See that file for why the split
 * exists rather than being a matter of taste.
 */
import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { backlinkEntrySchema } from '../references/backlink-entry.js'

export const backlinksInputSchema = z
  .object({ workspaceId: workspaceIdSchema, documentId: documentIdSchema })
  .strict()
export type BacklinksInput = z.infer<typeof backlinksInputSchema>

export const backlinksOutputSchema = z
  .object({
    backlinks: z.array(backlinkEntrySchema),
    /** Sources naming this document in prose without a resolving link. */
    unlinkedMentions: z.array(backlinkEntrySchema),
  })
  .strict()
export type BacklinksOutput = z.infer<typeof backlinksOutputSchema>
