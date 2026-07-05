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
})

export type CanvasSnapshot = z.infer<typeof canvasSnapshotSchema>
