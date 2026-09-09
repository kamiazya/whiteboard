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

/**
 * The one host the font installer will ever talk to.
 *
 * ADR-0012 decided the daemon takes a family ID and builds the request itself,
 * rather than accepting a URL and validating it. That is why this is a
 * constant and not configuration: "where can this reach" is a property of the
 * code, not of a validator someone has to keep correct.
 *
 * `google/fonts` is the Google Fonts catalogue's own repository, and serving
 * from it keeps the download to ONE hop. The `fonts.googleapis.com` CSS API is
 * two — it answers with a stylesheet naming files on `fonts.gstatic.com` — and
 * a fetch whose destination comes from a response body is the thing worth not
 * building. It also only offers `woff2`, which resvg's font database cannot
 * decode.
 */
export const FONT_SOURCE_ORIGIN = 'https://raw.githubusercontent.com'

const FONT_SOURCE_BASE = `${FONT_SOURCE_ORIGIN}/google/fonts/main/`

/**
 * The published item plus the source path, which the daemon's listing omits.
 *
 * Extended from the HTTP contract rather than declared beside it: the two
 * would otherwise drift, which is the exact failure the Zod-single-source rule
 * exists to prevent. `installed` is omitted because it is per-daemon state
 * answered at request time, not a property of the catalogue. The catalogue
 * lives in this browser-safe package because the web app fetches a theme's
 * family from the same source when no daemon holds it (ADR-0012's 2026-09-09
 * note); the daemon's install API still takes an id, never a URL.
 */
export const fontCatalogueEntrySchema = fontCatalogueItemSchema.omit({ installed: true }).extend({
  /** Path within the source repository. Joined onto the pinned base. */
  path: z.string().min(1),
})

export type FontCatalogueEntry = z.infer<typeof fontCatalogueEntrySchema>

/**
 * Every font a user can install, as data.
 *
 * One face per script rather than a style choice: this list exists to stop
 * exports rendering as tofu, and a second weight of a script already covered
 * fixes nothing. Noto because it is the family with systematic script
 * coverage, and all of it is OFL-1.1.
 */
export const FONT_CATALOGUE: readonly FontCatalogueEntry[] = [
  // The one entry that is a LOOK rather than a script: the family the
  // bundled `visual.sketch` theme names (ADR-0030). Japanese and Latin in
  // one hand, which is why it was chosen over a Latin-only handwriting face.
  {
    id: 'yomogi',
    family: 'Yomogi',
    scripts: ['Japanese', 'Latin'],
    license: 'OFL-1.1',
    approxBytes: 4_045_904,
    path: 'ofl/yomogi/Yomogi-Regular.ttf',
  },
  {
    id: 'noto-sans-jp',
    family: 'Noto Sans JP',
    scripts: ['Japanese'],
    license: 'OFL-1.1',
    approxBytes: 9_589_900,
    path: 'ofl/notosansjp/NotoSansJP[wght].ttf',
  },
  {
    id: 'noto-sans-sc',
    family: 'Noto Sans SC',
    scripts: ['Chinese (Simplified)'],
    license: 'OFL-1.1',
    approxBytes: 17_772_300,
    path: 'ofl/notosanssc/NotoSansSC[wght].ttf',
  },
  {
    id: 'noto-sans-tc',
    family: 'Noto Sans TC',
    scripts: ['Chinese (Traditional)'],
    license: 'OFL-1.1',
    approxBytes: 11_941_968,
    path: 'ofl/notosanstc/NotoSansTC[wght].ttf',
  },
  {
    id: 'noto-sans-kr',
    family: 'Noto Sans KR',
    scripts: ['Korean'],
    license: 'OFL-1.1',
    approxBytes: 10_414_588,
    path: 'ofl/notosanskr/NotoSansKR[wght].ttf',
  },
  {
    id: 'noto-sans-thai',
    family: 'Noto Sans Thai',
    scripts: ['Thai'],
    license: 'OFL-1.1',
    approxBytes: 218_652,
    path: 'ofl/notosansthai/NotoSansThai[wdth,wght].ttf',
  },
  {
    id: 'noto-sans-devanagari',
    family: 'Noto Sans Devanagari',
    scripts: ['Devanagari'],
    license: 'OFL-1.1',
    approxBytes: 647_144,
    path: 'ofl/notosansdevanagari/NotoSansDevanagari[wdth,wght].ttf',
  },
  {
    id: 'noto-sans-arabic',
    family: 'Noto Sans Arabic',
    scripts: ['Arabic'],
    license: 'OFL-1.1',
    approxBytes: 844_676,
    path: 'ofl/notosansarabic/NotoSansArabic[wdth,wght].ttf',
  },
  {
    id: 'noto-sans-hebrew',
    family: 'Noto Sans Hebrew',
    scripts: ['Hebrew'],
    license: 'OFL-1.1',
    approxBytes: 112_640,
    path: 'ofl/notosanshebrew/NotoSansHebrew[wdth,wght].ttf',
  },
]

export function fontCatalogueEntry(id: string): FontCatalogueEntry | undefined {
  return FONT_CATALOGUE.find((entry) => entry.id === id)
}

/** The entry for a FAMILY name — what a theme asset names, never an id. */
export function fontCatalogueEntryByFamily(family: string): FontCatalogueEntry | undefined {
  return FONT_CATALOGUE.find((entry) => entry.family === family)
}

/**
 * The single URL the installer may request for this entry.
 *
 * `new URL` percent-encodes the `[wght]` in Google's variable-font file names,
 * which is what the source expects. It also resolves a `path` that starts with
 * `/` or `//` against the *authority* rather than the base path, so an entry
 * spelled `//example.com/x` would silently retarget the download — hence the
 * origin is re-checked here rather than only in a test, which only covers the
 * entries that exist today.
 */
export function fontDownloadUrl(entry: FontCatalogueEntry): string {
  const url = new URL(entry.path, FONT_SOURCE_BASE)
  if (url.origin !== FONT_SOURCE_ORIGIN) {
    throw new Error(`Font catalogue entry ${entry.id} resolves outside ${FONT_SOURCE_ORIGIN}.`)
  }
  return url.toString()
}
