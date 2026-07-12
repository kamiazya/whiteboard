import { z } from 'zod'

// Request / response schemas for POST /api/canvas/:workspaceId/:slug/export-svg.
// Imported by the route handler and the export_svg MCP tool so the wire
// format has exactly one place to update. Unlike PNG export, SVG rendering
// always runs headless from the persisted document (see routes/canvas/
// export-svg.ts) — there is no browser round-trip, so no `scale` field:
// vector output is resolution-independent and scale is a raster-only concern.

export const exportSvgRequestSchema = z.object({
  padding: z.number().optional(),
  frameId: z.string().optional(),
  outputPath: z.string().optional(),
  overwrite: z.boolean().optional(),
  theme: z.enum(['light', 'dark']).optional(),
})

export const exportSvgResponseSchema = z.object({
  filePath: z.string(),
})

export type ExportSvgRequest = z.infer<typeof exportSvgRequestSchema>
export type ExportSvgResponse = z.infer<typeof exportSvgResponseSchema>
