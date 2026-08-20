import { z } from 'zod'

// Request / response schemas for POST /api/w/:workspaceId/document/<path>/export.
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
  /**
   * Characters this daemon's export fonts have no glyph for, in first-seen
   * order — the vendored Latin face plus whatever the user installed, and
   * nothing else (`loadSystemFonts: false`).
   *
   * Reported because of HOW it fails: measurement is correct, so the text
   * wraps in the right places, the boxes are the right size, and every other
   * signal says the render is fine. The only thing wrong is that a reader
   * cannot read it. Empty is the normal answer.
   *
   * The loss is not the same on both formats, and a caller relaying this to a
   * person should say which it means: a PNG has already lost these characters,
   * while an SVG still carries them as `<text>` and renders correctly for any
   * viewer whose own system has the face. Install one with
   * `POST /api/fonts/:id/install` (ADR-0012).
   */
  undrawable: z.array(z.string()),
  /**
   * Font families this render DECLARED that no loaded face provides. resvg
   * drew them in the fallback, so unlike `undrawable` nothing is missing on
   * the page — the text is legible and in the wrong face, which is why it
   * needs saying rather than showing.
   *
   * The other half of ADR-0011 decision 3: the resolved font set is part of
   * the render contract. `undrawable` is family-blind by construction — it
   * asks whether ANY loaded face has a glyph, never whether the face a run
   * named was among them — so this is the door that report cannot see
   * through. Empty is the normal answer.
   *
   * Install a family with `POST /api/fonts/:id/install` (ADR-0012).
   */
  unresolvedFamilies: z.array(z.string()),
})

// Shared error body. The route emits this for invalid_request /
// invalid_output_path (400), canvas_not_found (404), output_exists (409),
// payload_too_large (413), and headless_export_failed (500).
// All fields are optional since some 5xx bodies come from proxies that
// strip `error` without crashing the parser.
export const exportErrorBodySchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
})

export type ExportResponse = z.infer<typeof exportResponseSchema>
export type ExportErrorBody = z.infer<typeof exportErrorBodySchema>
