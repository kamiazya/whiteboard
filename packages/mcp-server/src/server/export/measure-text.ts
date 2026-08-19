// Composition-root implementation of canvas-render's injected text-
// measurement seam (packages/canvas-render/src/measure.ts). Layout never
// imports a font itself — this module supplies the real opentype.js-backed
// measurer. When the vendored asset is unavailable it degrades to
// canvas-render's shared constant-ratio measurer rather than a local copy.
import { readFile } from 'node:fs/promises'
import type { FontDescriptor, MeasureText, TextMetrics } from '@kamiazya/whiteboard-canvas-render'
import { constantRatioMeasureText } from '@kamiazya/whiteboard-canvas-render'
import * as opentype from 'opentype.js'

import { getLogger } from '../log.js'
import { EXPORT_FONT_FAMILY, type ExportFontFace, resolveExportFontFaces } from './export-font.js'
import { installedFontFiles } from './installed-fonts.js'

const log = getLogger('export-measure-text')

// opentype.js is CommonJS. Running from source (tsx) its exports land on the
// namespace root, but tsup's ESM interop nests them under `default` in the
// bundled dist. Reading only one of the two shapes throws
// "opentype.parse is not a function" in exactly one environment — the
// published package — where the fallback measurer then silently absorbs it
// and every export loses the real font metrics. Resolve whichever object
// actually carries the API.
const opentypeApi = (opentype as unknown as { default?: typeof opentype }).default ?? opentype

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
): MeasureText {
  return (text: string, descriptor: FontDescriptor): TextMetrics => {
    // A missing sibling face degrades to Regular metrics — the same glyphs
    // resvg would fall back to painting, so measure and paint stay agreed.
    const font = faces[faceForDescriptor(descriptor)] ?? regular
    return measureWithFont(font, text, descriptor)
  }
}

let cachedMeasurerPromise: Promise<MeasureText> | null = null
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

async function loadRealMeasurer(
  resolveFontFiles: () => Promise<Record<ExportFontFace, string | null>>,
): Promise<MeasureText> {
  try {
    const paths = await resolveFontFiles()
    const regular = await parseFace(paths.regular)
    if (regular === null) {
      logFallbackOnce('asset-not-found')
      return constantRatioMeasureText
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
    return buildOpentypeMeasurer(regular, faces)
  } catch (err) {
    logFallbackOnce(describeLoadFailure(err))
    return constantRatioMeasureText
  }
}

/**
 * Returns the canonical export `MeasureText`, backed by the vendored
 * opentype.js font. Parses the font asset at most once per process — the
 * parsed result (or, on failure, the fallback measurer) is cached and
 * reused by every caller.
 */
export async function createOpentypeMeasureText(
  options: { resolveFontFiles?: () => Promise<Record<ExportFontFace, string | null>> } = {},
): Promise<MeasureText> {
  if (!cachedMeasurerPromise) {
    cachedMeasurerPromise = loadRealMeasurer(options.resolveFontFiles ?? resolveExportFontFaces)
  }
  return cachedMeasurerPromise
}

/** Test-only: clears the module-level measurer cache and log-once flag. */
export function _resetExportMeasureTextCacheForTests(): void {
  cachedMeasurerPromise = null
  hasLoggedFallback = false
}
