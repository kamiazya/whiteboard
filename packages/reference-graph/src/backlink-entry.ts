/**
 * What one backlink answers with.
 *
 * Its own module rather than a declaration inside `reference-aggregate.ts`,
 * because `../contracts.ts` publishes the schema that names it to a BROWSER
 * and the aggregate around it reaches codec, ports and search. See
 * `../contracts.ts` for why that matters.
 */
import {
  documentIdSchema,
  documentKindSchema,
  documentPathSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'

export const backlinkEntrySchema = z
  .object({
    documentId: documentIdSchema,
    path: documentPathSchema,
    name: z.string().min(1).optional(),
    kind: documentKindSchema.optional(),
    /**
     * Short plain-text excerpts in document order, one per reference (or
     * per unlinked occurrence) up to the first three: enough to judge the
     * source, and a bound on an answer about a source dense with them.
     */
    contexts: z.array(z.string()),
  })
  .strict()
export type BacklinkEntry = z.infer<typeof backlinkEntrySchema>
