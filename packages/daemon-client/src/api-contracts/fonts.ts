import { z } from 'zod'

/**
 * A catalogue id, and the stem of the file the daemon writes.
 *
 * Constrained to a pattern with no path separator and no `.`: the id reaches
 * `join(dataDir, 'fonts', id + ext)`, and this is what stops anything shaped
 * like `../..` from naming a file outside that directory. The daemon takes an
 * id, never a URL — see ADR-0012.
 */
export const fontIdSchema = z.string().regex(/^[a-z0-9-]+$/)

export const fontCatalogueItemSchema = z.object({
  id: fontIdSchema,
  /** What the user picks, and what an SVG `font-family` can then name. */
  family: z.string().min(1),
  /** Human-readable coverage, for the picker. Not used for font matching. */
  scripts: z.array(z.string().min(1)).min(1),
  license: z.literal('OFL-1.1'),
  /** Size as measured upstream, so the picker can warn before a download. */
  approxBytes: z.number().int().positive(),
  /**
   * Whether the DAEMON has this font. The browser's own `FontFace` state is a
   * separate question with its own answer: ADR-0012 decision 4 — a font is not
   * a boolean, because either surface can have it without the other.
   */
  installed: z.boolean(),
})

export type FontCatalogueItem = z.infer<typeof fontCatalogueItemSchema>

export const listFontsResponseSchema = z.object({
  fonts: z.array(fontCatalogueItemSchema),
})

export type ListFontsResponse = z.infer<typeof listFontsResponseSchema>

export const installFontResponseSchema = z.object({
  id: fontIdSchema,
  family: z.string().min(1),
  bytes: z.number().int().positive(),
})

export type InstallFontResponse = z.infer<typeof installFontResponseSchema>
