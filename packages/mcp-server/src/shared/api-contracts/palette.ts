import { z } from 'zod'

// Request / response shapes for the /api/workspaces/:workspaceId/palette
// endpoints. Imported by both the route handler (validates incoming bodies +
// types its `c.json(...)` responses) and the MCP tool client (parses fetch
// responses) so a wire-format change has exactly one place to update.

export const paletteEntriesSchema = z.record(z.string(), z.string())

export const paletteResponseSchema = z.object({
  palette: paletteEntriesSchema,
})

export const paletteSetRequestSchema = z.object({
  entries: paletteEntriesSchema,
})

export const paletteDeleteRequestSchema = z.object({
  keys: z.array(z.string()).min(1),
})

export type PaletteEntries = z.infer<typeof paletteEntriesSchema>
export type PaletteResponse = z.infer<typeof paletteResponseSchema>
export type PaletteSetRequest = z.infer<typeof paletteSetRequestSchema>
export type PaletteDeleteRequest = z.infer<typeof paletteDeleteRequestSchema>
