import {
  documentIdSchema,
  documentKindSchema,
  documentPathSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'

/**
 * The browser keeper's listing row for one document: metadata only. Elements
 * are canonical in the Loro doc; this schema must never grow a scene/elements
 * field or the row and the content drift out of sync. `.strict()` is what
 * enforces that rather than a comment asking nicely.
 *
 * Nothing parses a stored row with it any more — the row is assembled from the
 * workspace's document index (`local-document-summary.ts`) — so it is the
 * single definition `DocumentSnapshot` is derived from, and its test pins the
 * shape.
 *
 * A local document is addressed exactly as the daemon addresses one — a ULID
 * document id, a workspace, and a path — so one set of port contracts can
 * describe both stores.
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
