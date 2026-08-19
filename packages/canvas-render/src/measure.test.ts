import { describe, expect, it } from 'vitest'
import { clampAdvance, constantRatioMeasureText } from './measure.js'

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
