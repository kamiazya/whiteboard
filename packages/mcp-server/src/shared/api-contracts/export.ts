import { z } from 'zod'

// Request / response schemas for POST /api/canvas/:workspaceId/:slug/export.
// Imported by the route handler (validates incoming body + types its
// `c.json(...)` responses) and the MCP export_canvas tool (parses fetch
// responses) so a wire-format change has exactly one place to update.

export const exportRequestSchema = z.object({
  padding: z.number().optional(),
  scale: z.number().optional(),
  minFontPx: z.number().optional(),
  frameId: z.string().optional(),
  outputPath: z.string().optional(),
  overwrite: z.boolean().optional(),
  // theme: forces the rendered scene into 'light' or 'dark'. Lets callers
  // export the same canvas under both themes for dark-mode QA / before-after
  // comparison without mutating the persisted appState.
  theme: z.enum(['light', 'dark']).optional(),
})

export const exportResponseSchema = z.object({
  filePath: z.string(),
})

// Shared error body. The route emits this for no_client (503), timeout (504),
// invalid_output_path / output_exists (400 / 409), and internal (500).
// All fields are optional on the parser side because the tool also surfaces
// non-standard 5xx bodies (e.g. proxies that strip `error`) without crashing.
export const exportErrorBodySchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
})

export type ExportRequest = z.infer<typeof exportRequestSchema>
export type ExportResponse = z.infer<typeof exportResponseSchema>
export type ExportErrorBody = z.infer<typeof exportErrorBodySchema>
