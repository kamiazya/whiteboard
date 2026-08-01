import { z } from 'zod'

// Request / response schemas for POST /api/canvas/:workspaceId/:slug/export.
// Imported by the route handler, which validates incoming bodies against
// exportRequestSchema and types its `c.json(...)` responses via the
// ExportResponse/ExportErrorBody types derived below.

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
// All fields are optional since some 5xx bodies come from proxies that
// strip `error` without crashing the parser.
export const exportErrorBodySchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
})

export type ExportResponse = z.infer<typeof exportResponseSchema>
export type ExportErrorBody = z.infer<typeof exportErrorBodySchema>
