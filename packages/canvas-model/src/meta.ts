import { z } from 'zod'

/**
 * Current OpenCanvas schema version for this repo. Pinned as a literal so
 * unknown/future versions fail parse loudly rather than being silently
 * accepted. When a v2 model lands, replace `z.literal(CANVAS_SCHEMA_VERSION)`
 * with a discriminated union keyed on `schemaVersion` (1 | 2) so both shapes
 * can be parsed side by side during migration.
 */
export const CANVAS_SCHEMA_VERSION = 1 as const

export const canvasMetaSchema = z.object({
  format: z.enum(['markdown', 'spatial']),
  schemaVersion: z.literal(CANVAS_SCHEMA_VERSION),
})

export type CanvasMeta = z.infer<typeof canvasMetaSchema>
