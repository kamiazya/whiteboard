import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'

/**
 * A DocRef identifies which sync-able document a store/sync operation
 * targets. Two kinds exist because the document model has exactly two
 * Loro-backed document types: an individual document, and the single
 * workspace-tree document. Adding a third document type extends this
 * union rather than overloading either variant.
 *
 * A document ref carries its workspace: the workspace record is what
 * projects the document, so a consumer holding the ref can reach that
 * record without a reverse index over documentIds. The STORED key
 * (`docRefKey`) deliberately does not include it — see doc-ref-key.ts.
 */
export const docRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('document'),
      workspaceId: workspaceIdSchema,
      documentId: documentIdSchema,
    })
    .strict(),
  z.object({ kind: z.literal('workspace-tree'), workspaceId: workspaceIdSchema }).strict(),
])

export type DocRef = z.infer<typeof docRefSchema>
