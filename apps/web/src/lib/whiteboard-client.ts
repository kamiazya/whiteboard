import { z } from 'zod'

/**
 * Persisted JSON 'canvases' row: metadata only. Elements are canonical in the
 * Loro doc ('loroCanvases' store); this schema must never grow a scene/elements
 * field again or the two stores drift out of sync.
 */
export const canvasSnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  updatedAt: z.string(),
  /**
   * Which editor opens this canvas. Defaulted so rows persisted before the
   * field existed parse as spatial — the only kind that existed then.
   * Content stays in the Loro doc either way (spatial: nodes/edges maps;
   * markdown: a 'body' text container) — this is still metadata only.
   */
  kind: z.enum(['spatial', 'markdown']).default('spatial'),
})

export type CanvasSnapshot = z.infer<typeof canvasSnapshotSchema>
