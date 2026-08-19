import {
  documentIdSchema,
  documentKindSchema,
  documentPathSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'

/**
 * Persisted JSON 'documents' row: metadata only. Elements are canonical in the
 * Loro doc ('loroDocuments' store); this schema must never grow a scene/elements
 * field again or the two stores drift out of sync. `.strict()` is what enforces
 * that rather than a comment asking nicely.
 *
 * A local document is addressed exactly as the daemon addresses one — a ULID
 * document id, a workspace, and a path — so one set of port contracts can
 * describe both stores. The previous shape (a `crypto.randomUUID()` in an
 * `id` field, no workspace, no path) could not satisfy `DocRef` at all, which
 * is what kept the two halves of this product apart.
 */
export const documentSnapshotSchema = z
  .object({
    documentId: documentIdSchema,
    workspaceId: workspaceIdSchema,
    path: documentPathSchema,
    name: z.string(),
    updatedAt: z.string(),
    /**
     * Which editor opens this document. Defaulted because content lives in
     * the Loro doc either way (spatial: nodes/edges maps; markdown: a 'body'
     * text container) — this row is still metadata only.
     */
    kind: documentKindSchema.default('spatial'),
  })
  .strict()

export type DocumentSnapshot = z.infer<typeof documentSnapshotSchema>
