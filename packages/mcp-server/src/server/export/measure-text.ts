// Composition-root implementation of canvas-render's injected text-
// measurement seam (packages/canvas-render/src/measure.ts). Layout never
// imports a font itself — this module supplies the real opentype.js-backed
// measurer. When the vendored asset is unavailable it degrades to
// canvas-render's shared constant-ratio measurer rather than a local copy.
import { readFile } from 'node:fs/promises'
import type { FontDescriptor, MeasureText, TextMetrics } from '@kamiazya/whiteboard-canvas-render'
import { constantRatioMeasureText } from '@kamiazya/whiteboard-canvas-render'
import type * as opentype from 'opentype.js'

import { opentypeApi } from '../../shared/opentype.js'
import { getLogger } from '../log.js'
import {
  EXPORT_FONT_FAMILY,
  type ExportFontFace,
  readFontFamilyName,
  resolveExportFontFaces,
} from './export-font.js'
import { installedFontFiles } from './installed-fonts.js'

const log = getLogger('export-measure-text')

function clampNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/** CSS-style face selection: 600+ is bold, per the numeric weight scale. */
export function faceForDescriptor(descriptor: FontDescriptor): ExportFontFace {
  const bold = descriptor.weight >= 600
  const italic = descriptor.style === 'italic'
  if (bold && italic) return 'boldItalic'
  if (bold) return 'bold'
  if (italic) return 'italic'
  return 'regular'
}

/**
 * The vendored face is Latin-only, and `opentype.js` does not report that: a
 * code point it has no glyph for is measured as `.notdef`, a flat ~0.44 em
 * that is not a measurement of anything. Left alone it understates Japanese
 * by more than the constant-ratio estimator it is supposed to improve on —
 * measured, `あ` at 7.1px against a true 16px — so "lay out with the real
 * font" would be a regression for every non-Latin canvas.
 *
 * The face is asked by GLYPH INDEX rather than by comparing advances: a
 * legitimately narrow glyph can share `.notdef`'s width, and comparing would
 * throw it away.
 *
 * Fixing it properly means shipping a CJK face, which is a font-distribution
 * decision rather than a layout one.
 * ponytail: estimate the glyphs the face lacks; ship a CJK face when export
 * fidelity for those scripts is worth the package size.
 */
function measureAdvance(
  font: opentype.Font,
  text: string,
  descriptor: FontDescriptor,
  sizePx: number,
): number {
  const carried = (char: string): boolean => font.charToGlyphIndex(char) !== 0
  // Nothing missing is the common case and stays exactly one call into the
  // font, so a Latin canvas measures no differently than before.
  let allCarried = true
  for (const char of text) {
    if (!carried(char)) {
      allCarried = false
      break
    }
  }
  if (allCarried) return font.getAdvanceWidth(text, sizePx, { kerning: false })

  let advance = 0
  let run = ''
  const flush = (): void => {
    if (run === '') return
    advance += font.getAdvanceWidth(run, sizePx, { kerning: false })
    run = ''
  }
  for (const char of text) {
    if (carried(char)) {
      run += char
      continue
    }
    flush()
    advance += constantRatioMeasureText(char, descriptor).advanceWidth
  }
  flush()
  return advance
}

function measureWithFont(
  font: opentype.Font,
  text: string,
  descriptor: FontDescriptor,
): TextMetrics {
  const unitsPerEm = font.unitsPerEm > 0 ? font.unitsPerEm : 1000
  // hhea.lineGap is a raw font-design-unit value; Table's index signature
  // types it `any`, so coerce explicitly rather than propagate `any`.
  const lineGapUnits = Number(font.tables.hhea?.lineGap) || 0
  const sizePx = clampNonNegative(descriptor.sizePx)
  const scale = sizePx / unitsPerEm
  // Kerning is disabled deliberately: it would make advanceWidth(a + b)
  // only approximately equal to advanceWidth(a) + advanceWidth(b) at the
  // kerning-pair seam, which this measurer's callers rely on being exact.
  // That additivity is also what lets the mixed-script path below measure
  // run by run and sum the pieces.
  const advanceWidth =
    sizePx === 0 || text.length === 0
      ? 0
      : clampNonNegative(measureAdvance(font, text, descriptor, sizePx))
  return {
    advanceWidth,
    ascent: clampNonNegative(font.ascender * scale),
    descent: clampNonNegative(Math.abs(font.descender) * scale),
    lineGap: clampNonNegative(lineGapUnits * scale),
  }
}

function buildOpentypeMeasurer(
  regular: opentype.Font,
  faces: Partial<Record<ExportFontFace, opentype.Font>>,
  installed: ReadonlyMap<string, opentype.Font>,
): MeasureText {
  return (text: string, descriptor: FontDescriptor): TextMetrics => {
    // The family the descriptor NAMES wins, because that name is what the SVG
    // declares and therefore what resvg paints with: measuring an installed
    // family's run with the vendored face computes every wrap position, fade
    // and fitted height for a face nothing draws.
    //
    // A CSS chain (`ui-monospace, ..., monospace`) matches no entry and falls
    // through, which is correct — no loaded face provides it either, so the
    // fallback measures what the fallback paints.
    const named = installed.get(descriptor.family)
    // A missing sibling face degrades to Regular metrics — the same glyphs
    // resvg would fall back to painting, so measure and paint stay agreed.
    const font = named ?? faces[faceForDescriptor(descriptor)] ?? regular
    return measureWithFont(font, text, descriptor)
  }
}

/**
 * The export's text measurement, and the families it can answer for.
 *
 * One value rather than two, because they are one decision: the layout
 * DECLARES a family exactly where `measurableFamilies` admits it
 * (`fontAvailable`), so a second list built somewhere else is how a declared
 * family stops being the measured one.
 */
export interface ExportTextMeasurer {
  readonly measure: MeasureText
  /** Every family `measure` has a real face for — what may be declared. */
  readonly measurableFamilies: ReadonlySet<string>
}

let cachedMeasurerPromise: Promise<ExportTextMeasurer> | null = null
let hasLoggedFallback = false

/**
 * A path-free description of why the font failed to load. The raw error is
 * deliberately NOT logged: its `stack` (and an `ENOENT` message) carry
 * absolute filesystem paths, and the packaged-distribution smoke asserts the
 * daemon never leaks a home-directory path to stderr.
 */
function describeLoadFailure(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown'
  const code = (err as NodeJS.ErrnoException).code
  return code ? `${err.name}(${code})` : err.name
}

function logFallbackOnce(reason: string): void {
  if (hasLoggedFallback) return
  hasLoggedFallback = true
  log.warning(
    { family: EXPORT_FONT_FAMILY, reason },
    'export font asset unavailable; falling back to a constant-ratio text measurer. ' +
      'Output on this path is NOT byte-reproducible with the real font.',
  )
}

async function parseFace(path: string | null): Promise<opentype.Font | null> {
  if (path === null) return null
  const buffer = await readFile(path)
  return opentypeApi.parse(buffer)
}

/**
 * The parsed Regular face the export path draws with, or `null` when the
 * vendored asset is unreachable and the render has already degraded to system
 * fonts.
 *
 * Exposed for `undrawableCharacters`, which asks the same question the
 * measurer asks internally — does this face carry a glyph for this code point
 * — but reports the answer instead of silently estimating around it. Parsed
 * on demand and NOT cached here: the answer is needed once per export, while
 * the measurer's own cache exists because layout calls it per line.
 */
export async function loadExportFont(
  resolveFontFiles: () => Promise<Record<ExportFontFace, string | null>> = resolveExportFontFaces,
): Promise<opentype.Font | null> {
  try {
    return await parseFace((await resolveFontFiles()).regular)
  } catch {
    return null
  }
}

/**
 * Every face the export path draws with: the vendored Regular plus whatever
 * the user installed.
 *
 * This is the set `undrawableCharacters` has to ask, not just the vendored
 * one. A report built from a narrower set than the renderer uses answers about
 * a picture nobody produced — it would keep naming characters an installed
 * font now draws perfectly.
 *
 * A face that fails to parse is skipped rather than fatal: it cannot draw
 * anything, so it contributes nothing to the question being asked, and a
 * corrupt file in the directory must not take the export down with it.
 */
export async function loadExportFonts(
  resolveFontFiles: () => Promise<Record<ExportFontFace, string | null>> = resolveExportFontFaces,
): Promise<readonly opentype.Font[]> {
  const paths = [(await resolveFontFiles()).regular, ...(await installedFontFiles())]
  const fonts: opentype.Font[] = []
  for (const path of paths) {
    try {
      const font = await parseFace(path)
      if (font !== null) fonts.push(font)
    } catch {
      // Skipped on purpose — see above.
    }
  }
  return fonts
}

/**
 * The installed faces (ADR-0012) by the family name a theme would name, so a
 * family the user provided can be both declared and measured.
 *
 * The vendored family is skipped: it is served by four faces the weight/style
 * dispatch already selects among, and a single installed file of the same name
 * would replace all four with one. First file wins among same-named faces,
 * which is the sorted directory order `installedFontFiles` fixes — the same
 * order resvg resolves them in.
 *
 * A face that fails to parse is skipped rather than fatal, for the reason
 * `loadExportFonts` skips one: it cannot draw anything, so it measures
 * nothing, and a corrupt file in the directory must not take the export down.
 */
async function loadInstalledFamilies(): Promise<ReadonlyMap<string, opentype.Font>> {
  const families = new Map<string, opentype.Font>()
  for (const path of await installedFontFiles()) {
    try {
      const font = await parseFace(path)
      if (font === null) continue
      const family = readFontFamilyName(font)
      if (family === undefined || family === EXPORT_FONT_FAMILY || families.has(family)) continue
      families.set(family, font)
    } catch {
      // Skipped on purpose — see above.
    }
  }
  return families
}

// The bundled family is always answerable: it is what the layout falls back to
// DECLARING when a theme's family is not available, including on the degraded
// path below where nothing is measured with a real face at all.
const BUNDLED_ONLY: ReadonlySet<string> = new Set([EXPORT_FONT_FAMILY])

async function loadRealMeasurer(
  resolveFontFiles: () => Promise<Record<ExportFontFace, string | null>>,
): Promise<ExportTextMeasurer> {
  try {
    const paths = await resolveFontFiles()
    const regular = await parseFace(paths.regular)
    if (regular === null) {
      logFallbackOnce('asset-not-found')
      return { measure: constantRatioMeasureText, measurableFamilies: BUNDLED_ONLY }
    }
    const faces: Partial<Record<ExportFontFace, opentype.Font>> = { regular }
    for (const face of ['bold', 'italic', 'boldItalic'] as const) {
      // A sibling face failing to parse degrades that face only — Regular
      // already loaded, so the export is degraded, not blocked.
      try {
        const parsed = await parseFace(paths[face])
        if (parsed !== null) faces[face] = parsed
      } catch (err) {
        logFallbackOnce(describeLoadFailure(err))
      }
    }
    const installed = await loadInstalledFamilies()
    return {
      measure: buildOpentypeMeasurer(regular, faces, installed),
      measurableFamilies: new Set([EXPORT_FONT_FAMILY, ...installed.keys()]),
    }
  } catch (err) {
    logFallbackOnce(describeLoadFailure(err))
    return { measure: constantRatioMeasureText, measurableFamilies: BUNDLED_ONLY }
  }
}

/**
 * The canonical export measurer: the vendored opentype.js faces plus every
 * installed family, and the one answer to which families may be declared.
 *
 * Parses the font assets at most once per process — the parsed result (or, on
 * failure, the fallback measurer) is cached and reused by every caller. A font
 * installed later reaches resvg on the next export (the renderer resolves
 * `fontFiles` per render) but is not measured until this cache is rebuilt, so
 * it is drawn in the bundled family it was also measured in — degraded, never
 * mismatched.
 * ponytail: key the cache on the installed directory if a font installed
 * mid-session must change the very next export's declarations.
 */
export async function createExportTextMeasurer(
  options: { resolveFontFiles?: () => Promise<Record<ExportFontFace, string | null>> } = {},
): Promise<ExportTextMeasurer> {
  if (!cachedMeasurerPromise) {
    cachedMeasurerPromise = loadRealMeasurer(options.resolveFontFiles ?? resolveExportFontFaces)
  }
  return cachedMeasurerPromise
}

/**
 * The measurement half alone, for callers with no family question to ask —
 * the DI container's `measure` seam, which lays scenes out for tools that
 * declare the bundled family unconditionally.
 */
export async function createOpentypeMeasureText(
  options: { resolveFontFiles?: () => Promise<Record<ExportFontFace, string | null>> } = {},
): Promise<MeasureText> {
  return (await createExportTextMeasurer(options)).measure
}

/** Test-only: clears the module-level measurer cache and log-once flag. */
export function _resetExportMeasureTextCacheForTests(): void {
  cachedMeasurerPromise = null
  hasLoggedFallback = false
}
