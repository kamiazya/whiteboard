// Composition-root implementation of canvas-render's injected text-
// measurement seam (packages/canvas-render/src/measure.ts). Layout never
// imports a font itself — this module supplies the real opentype.js-backed
// measurer, plus a constant-ratio fallback for when the vendored asset is
// unavailable.
import { readFile } from 'node:fs/promises'
import type { FontDescriptor, MeasureText, TextMetrics } from '@kamiazya/whiteboard-canvas-render'
import * as opentype from 'opentype.js'

import { getLogger } from '../log.js'
import { EXPORT_FONT_FAMILY, resolveExportFontFile } from './export-font.js'

const log = getLogger('export-measure-text')

// Every glyph advance/vertical metric below is a rough Latin-sans-serif
// average expressed as a fraction of sizePx. This measurer is used only
// when the real vendored font cannot be loaded, so its output is NOT
// byte-reproducible with a real opentype.js/browser Canvas measurement —
// it exists solely so export still succeeds (degraded, not blocked).
const FALLBACK_ADVANCE_RATIO = 0.55
const FALLBACK_ASCENT_RATIO = 0.75
const FALLBACK_DESCENT_RATIO = 0.25
const FALLBACK_LINE_GAP_RATIO = 0.1

function clampNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * A deterministic, font-independent measurer used when the real export
 * font asset cannot be loaded. Satisfies the same `MeasureText` contract
 * (finite, non-negative, `advanceWidth('') === 0`, linear in `sizePx`) but
 * its pixel output does not match any real font — a fallback export is a
 * degraded export, not a byte-reproducible one.
 */
export function createConstantRatioMeasureText(): MeasureText {
  return (text: string, font: FontDescriptor): TextMetrics => {
    const sizePx = clampNonNegative(font.sizePx)
    return {
      advanceWidth: clampNonNegative(text.length * sizePx * FALLBACK_ADVANCE_RATIO),
      ascent: clampNonNegative(sizePx * FALLBACK_ASCENT_RATIO),
      descent: clampNonNegative(sizePx * FALLBACK_DESCENT_RATIO),
      lineGap: clampNonNegative(sizePx * FALLBACK_LINE_GAP_RATIO),
    }
  }
}

function buildOpentypeMeasurer(font: opentype.Font): MeasureText {
  const unitsPerEm = font.unitsPerEm > 0 ? font.unitsPerEm : 1000
  // hhea.lineGap is a raw font-design-unit value; Table's index signature
  // types it `any`, so coerce explicitly rather than propagate `any`.
  const lineGapUnits = Number(font.tables.hhea?.lineGap) || 0
  return (text: string, descriptor: FontDescriptor): TextMetrics => {
    const sizePx = clampNonNegative(descriptor.sizePx)
    const scale = sizePx / unitsPerEm
    // Kerning is disabled deliberately: it would make advanceWidth(a + b)
    // only approximately equal to advanceWidth(a) + advanceWidth(b) at the
    // kerning-pair seam, which this measurer's callers rely on being exact.
    const advanceWidth =
      sizePx === 0 || text.length === 0
        ? 0
        : clampNonNegative(font.getAdvanceWidth(text, sizePx, { kerning: false }))
    return {
      advanceWidth,
      ascent: clampNonNegative(font.ascender * scale),
      descent: clampNonNegative(Math.abs(font.descender) * scale),
      lineGap: clampNonNegative(lineGapUnits * scale),
    }
  }
}

let cachedMeasurerPromise: Promise<MeasureText> | null = null
let hasLoggedFallback = false

function logFallbackOnce(err: unknown): void {
  if (hasLoggedFallback) return
  hasLoggedFallback = true
  log.warning(
    { err },
    'export font asset unavailable; falling back to a constant-ratio text measurer. ' +
      'Output on this path is NOT byte-reproducible with the real font.',
  )
}

async function loadRealMeasurer(
  resolveFontFile: () => Promise<string | null>,
): Promise<MeasureText> {
  try {
    const fontPath = await resolveFontFile()
    if (!fontPath) {
      throw new Error(`export font asset "${EXPORT_FONT_FAMILY}" not found`)
    }
    const buffer = await readFile(fontPath)
    const font = opentype.parse(buffer)
    return buildOpentypeMeasurer(font)
  } catch (err) {
    logFallbackOnce(err)
    return createConstantRatioMeasureText()
  }
}

/**
 * Returns the canonical export `MeasureText`, backed by the vendored
 * opentype.js font. Parses the font asset at most once per process — the
 * parsed result (or, on failure, the fallback measurer) is cached and
 * reused by every caller.
 */
export async function createOpentypeMeasureText(
  options: { resolveFontFile?: () => Promise<string | null> } = {},
): Promise<MeasureText> {
  if (!cachedMeasurerPromise) {
    cachedMeasurerPromise = loadRealMeasurer(options.resolveFontFile ?? resolveExportFontFile)
  }
  return cachedMeasurerPromise
}

/** Test-only: clears the module-level measurer cache and log-once flag. */
export function _resetExportMeasureTextCacheForTests(): void {
  cachedMeasurerPromise = null
  hasLoggedFallback = false
}
