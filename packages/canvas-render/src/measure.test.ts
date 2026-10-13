import { describe, expect, it } from 'vitest'
import { clampAdvance, constantRatioMeasureText, isFullWidthCodePoint } from './measure.js'

describe('clampAdvance', () => {
  it('passes through a finite non-negative advance unchanged', () => {
    expect(clampAdvance(12.5)).toBe(12.5)
    expect(clampAdvance(0)).toBe(0)
  })

  it('clamps a non-finite advance to 0', () => {
    expect(clampAdvance(Number.NaN)).toBe(0)
    expect(clampAdvance(Number.POSITIVE_INFINITY)).toBe(0)
    expect(clampAdvance(Number.NEGATIVE_INFINITY)).toBe(0)
  })

  it('clamps a negative advance to 0', () => {
    expect(clampAdvance(-5)).toBe(0)
  })
})

describe('constantRatioMeasureText', () => {
  const font = {
    family: 'sans-serif',
    fallbackChain: [] as readonly string[],
    weight: 400,
    style: 'normal' as const,
    sizePx: 16,
  }

  it('returns an advance proportional to text length and font size', () => {
    expect(constantRatioMeasureText('hello', font).advanceWidth).toBeCloseTo(5 * 0.55 * 16)
  })

  it('measures the empty string to a zero advance', () => {
    expect(constantRatioMeasureText('', font).advanceWidth).toBe(0)
  })

  it('scales linearly with sizePx', () => {
    const small = constantRatioMeasureText('ab', { ...font, sizePx: 10 })
    const large = constantRatioMeasureText('ab', { ...font, sizePx: 20 })
    expect(large.advanceWidth).toBeCloseTo(small.advanceWidth * 2)
  })

  it('splits the em box into the documented ascent/descent/lineGap ratios', () => {
    const metrics = constantRatioMeasureText('x', font)
    expect(metrics.ascent).toBeCloseTo(16 * 0.75)
    expect(metrics.descent).toBeCloseTo(16 * 0.25)
    expect(metrics.lineGap).toBeCloseTo(16 * 0.1)
  })

  it('clamps a non-finite or negative sizePx to zero metrics rather than propagating it', () => {
    for (const sizePx of [Number.NaN, Number.POSITIVE_INFINITY, -12]) {
      const metrics = constantRatioMeasureText('abc', { ...font, sizePx })
      expect(metrics).toEqual({ advanceWidth: 0, ascent: 0, descent: 0, lineGap: 0 })
    }
  })

  // A ratio is a model, not a calibration. Charging a kana the same fraction
  // as an 'i' is not an approximation of Japanese, it is the wrong model,
  // and it is what made `wb_scene_digest` report nothing hidden for a node
  // the editor was painting a fade on.
  it('charges a fullwidth character a full em, not the Latin ratio', () => {
    expect(constantRatioMeasureText('あ', font).advanceWidth).toBeCloseTo(16)
    expect(constantRatioMeasureText('漢', font).advanceWidth).toBeCloseTo(16)
    expect(constantRatioMeasureText('한', font).advanceWidth).toBeCloseTo(16)
  })

  it('adds the two up for mixed text', () => {
    // 'API' + 'を' + 'call' -> 7 Latin at 0.55 em, 1 fullwidth at 1 em.
    expect(constantRatioMeasureText('APIをcall', font).advanceWidth).toBeCloseTo(
      (7 * 0.55 + 1) * 16,
    )
  })

  // `text.length` counts UTF-16 units, so an astral code point was charged
  // twice over. Iterating code points is what the fullwidth test above needs
  // anyway, and it fixes this at the same time.
  it('charges an astral code point once, not once per surrogate', () => {
    expect(constantRatioMeasureText('🚀', font).advanceWidth).toBeCloseTo(16)
  })
})

// The wide ranges, written out independently of the implementation so an
// off-by-one at either edge of any one of them shows up as a disagreement.
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0x3040, 0x30ff], // hiragana + katakana
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xff00, 0xff60], // fullwidth forms
  [0x1f300, 0x1faff], // emoji
]
const inTable = (cp: number) => WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)

describe('isFullWidthCodePoint', () => {
  it.each(
    WIDE_RANGES.map(([lo, hi]) => [lo.toString(16), lo, hi] as const),
  )('counts both edges of the range starting U+%s as wide, and its neighbours by the table', (_label, lo, hi) => {
    expect(isFullWidthCodePoint(lo)).toBe(true)
    expect(isFullWidthCodePoint(hi)).toBe(true)
    // Two ranges abut (U+303F / U+3040), so a neighbour is narrow only
    // when no other range claims it.
    expect(isFullWidthCodePoint(lo - 1)).toBe(inTable(lo - 1))
    expect(isFullWidthCodePoint(hi + 1)).toBe(inTable(hi + 1))
  })

  it('reads the commonest ideograph as wide and Latin as narrow', () => {
    expect(isFullWidthCodePoint('一'.codePointAt(0) ?? 0)).toBe(true)
    expect(isFullWidthCodePoint('a'.codePointAt(0) ?? 0)).toBe(false)
  })
})
