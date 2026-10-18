import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import type { FontDescriptor, MeasureText } from '../../measure.js'
import { clampAdvance } from '../../measure.js'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { fitToWidth } from './truncate.js'

/**
 * `fitToWidth` finds its prefix by search; it used to find it by a
 * unit-by-unit scan. The scan is FROZEN below as the reference — copied from
 * the implementation it was, not derived from the search — and the property
 * holds the two to the same answer, flags included, on any measurer whose
 * width is monotone in prefix length.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function mayCluster(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0x0300 || code === 0x000d) return true
  }
  return false
}

function* cutUnits(text: string): Generator<string> {
  if (!mayCluster(text)) {
    yield* text
    return
  }
  for (const { segment } of GRAPHEMES.segment(text)) yield segment
}

function scanFitToWidth(
  text: string,
  font: FontDescriptor,
  measure: MeasureText,
  maxWidth: number,
) {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return { text }
  if (clampAdvance(measure(text, font).advanceWidth) <= maxWidth) return { text }
  let fitted = ''
  let firstUnit = ''
  for (const unit of cutUnits(text)) {
    if (firstUnit === '') firstUnit = unit
    const candidate = fitted + unit
    if (clampAdvance(measure(candidate, font).advanceWidth) > maxWidth) break
    fitted = candidate
  }
  const kept = fitted === '' ? firstUnit : fitted
  return {
    text: kept,
    ...(kept === text ? {} : { truncated: true as const }),
    ...(fitted === '' ? { overflows: true as const } : {}),
  }
}

const font: FontDescriptor = {
  family: 'Test',
  fallbackChain: [],
  weight: 400,
  style: 'normal',
  sizePx: 10,
}

/**
 * Unequal advances per code point, so a cut can fall anywhere rather than
 * only at a multiple of one width; additive, and so monotone.
 */
const unevenMeasure: MeasureText = (text) => {
  let advance = 0
  for (const char of text) advance += 1 + ((char.codePointAt(0) ?? 0) % 7)
  return { advanceWidth: advance, ascent: 8, descent: 2, lineGap: 0 }
}

/** Monotone but not additive: a run is charged a whole number of "cells". */
const cellMeasure: MeasureText = (text) => ({
  advanceWidth: Math.ceil(unevenMeasure(text, font).advanceWidth / 5) * 5,
  ascent: 8,
  descent: 2,
  lineGap: 0,
})

const pieceArb = fc.constantFrom('a', 'word ', 'の', '漢字', '👨‍👩‍👧', 'é', '\r\n', '🇯🇵', '  ', 'x')
const textArb = fc.oneof(
  {
    weight: 3,
    arbitrary: fc
      .array(pieceArb, { minLength: 1, maxLength: 80, size: 'max' })
      .map((pieces) => pieces.join('')),
  },
  { weight: 1, arbitrary: fc.string({ minLength: 1, maxLength: 40 }) },
)

const LONG_CUT = 20
let longCuts = 0

describe('fitToWidth agrees with the scan it replaced', () => {
  afterAllFloor(['the same answer, flags included, on monotone measurers'], () => {
    // The search only differs from a scan on a LONG kept prefix; a domain
    // that never cuts one would pass this property vacuously.
    expect(longCuts).toBeGreaterThan(30)
  })

  fcTest.prop(
    [
      textArb,
      fc.oneof(
        fc.double({ min: 0.01, max: 1.2, noNaN: true }),
        fc.double({ min: 0.5, max: 0.99, noNaN: true }),
      ),
      fc.boolean(),
    ],
    withDefaults(),
  )('the same answer, flags included, on monotone measurers', (text, fraction, cells) => {
    const measure = cells ? cellMeasure : unevenMeasure
    const maxWidth = clampAdvance(measure(text, font).advanceWidth) * fraction
    const searched = fitToWidth(text, font, measure, maxWidth)
    if (searched.truncated && searched.text.length >= LONG_CUT) longCuts += 1
    expect(searched).toEqual(scanFitToWidth(text, font, measure, maxWidth))
  })
})
