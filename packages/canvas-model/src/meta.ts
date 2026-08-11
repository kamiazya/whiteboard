import { z } from 'zod'

/**
 * Current OpenCanvas schema version for this repo. Pinned as a literal so
 * unknown/future versions fail parse loudly rather than being silently
 * accepted. When a v2 model lands, replace `z.literal(CANVAS_SCHEMA_VERSION)`
 * with a discriminated union keyed on `schemaVersion` (1 | 2) so both shapes
 * can be parsed side by side during migration.
 */
export const CANVAS_SCHEMA_VERSION = 1 as const

// Single source of truth for the spatial/markdown split: canvasMetaSchema's
// `format` and every kind-carrying contract downstream (mcp-server
// api-contracts, the browser-local IndexedDB schema) reference this instead
// of restating the two literals.
export const canvasKindSchema = z.enum(['spatial', 'markdown'])
export type CanvasKind = z.infer<typeof canvasKindSchema>

export const canvasMetaSchema = z.object({
  format: canvasKindSchema,
  schemaVersion: z.literal(CANVAS_SCHEMA_VERSION),
})

export type CanvasMeta = z.infer<typeof canvasMetaSchema>
