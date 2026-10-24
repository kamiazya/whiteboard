/**
 * The input and output contracts of the route
 * `PUT /api/v1/workspaces/:workspaceId/tag-library`, and nothing else.
 *
 * Schemas only, so `../contracts.ts` can publish them to a BROWSER without
 * the operation's own graph coming with them.
 */
import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { tagLibrarySchema } from '@kamiazya/whiteboard-plugin-visual/tag-library'
import { z } from 'zod'

export const setTagLibraryInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    /** The WHOLE declared vocabulary: what is stored afterwards, so a key left out is a key dropped. */
    library: tagLibrarySchema,
  })
  .strict()
export type SetTagLibraryInput = z.infer<typeof setTagLibraryInputSchema>

export const setTagLibraryOutputSchema = z
  .object({
    /** The document holding the library, which this write may have just created. */
    documentId: documentIdSchema,
  })
  .strict()
export type SetTagLibraryOutput = z.infer<typeof setTagLibraryOutputSchema>
