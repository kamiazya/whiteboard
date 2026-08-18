import { documentKindSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'

/**
 * Persisted JSON 'documents' row: metadata only. Elements are canonical in the
 * Loro doc ('loroDocuments' store); this schema must never grow a scene/elements
 * field again or the two stores drift out of sync.
 */
export const documentSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  updatedAt: z.string(),
  /**
   * Which editor opens this canvas. Defaulted so rows persisted before the
   * field existed parse as spatial — the only kind that existed then.
   * Content stays in the Loro doc either way (spatial: nodes/edges maps;
   * markdown: a 'body' text container) — this is still metadata only.
   */
  kind: documentKindSchema.default('spatial'),
})

export type DocumentSnapshot = z.infer<typeof documentSnapshotSchema>
