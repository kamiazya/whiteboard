import { spatialRenderStyleSchema } from '@kamiazya/whiteboard-canvas-render'
import { z } from 'zod'

// Request schema for POST /api/w/:workspaceId/document/<path>/export-svg.
// Imported by the route handler so the wire format has exactly one place
// to update. Unlike PNG export, SVG rendering always runs headless from
// the persisted document (see routes/document/export-svg.ts) — there is no
// browser round-trip, so no `scale` field: vector output is
// resolution-independent and scale is a raster-only concern.

export const exportSvgRequestSchema = z.object({
  // Same bounds as the PNG export's padding: it widens the bounds on every
  // side, so a huge one is a document no reader can open.
  padding: z.number().nonnegative().max(1024).optional(),
  frameId: z.string().optional(),
  outputPath: z.string().optional(),
  overwrite: z.boolean().optional(),
  theme: z.enum(['light', 'dark']).optional(),
  // style: which look to draw (ADR-0030 decision 6). Absent is 'clean', so
  // an export never picks up the document's theme unasked; 'document' draws
  // the theme the canvas names; a theme id previews one.
  style: spatialRenderStyleSchema.optional(),
})

export type ExportSvgRequest = z.infer<typeof exportSvgRequestSchema>
