import { describe, expect, it } from 'vitest'
import { fallbackMeasureText } from './fallback-measure.js'

describe('fallbackMeasureText', () => {
  const font = {
    sizePx: 16,
    family: 'sans-serif',
    fallbackChain: [] as readonly string[],
    weight: 400,
    style: 'normal' as const,
  }

  it('returns advanceWidth proportional to text length and font size', () => {
    const metrics = fallbackMeasureText('hello', font)
    expect(metrics.advanceWidth).toBeCloseTo(5 * 0.55 * 16)
  })

  it('returns zero advanceWidth for empty text', () => {
    const metrics = fallbackMeasureText('', font)
    expect(metrics.advanceWidth).toBe(0)
  })

  it('scales linearly with font size', () => {
    const small = fallbackMeasureText('ab', { ...font, sizePx: 10 })
    const large = fallbackMeasureText('ab', { ...font, sizePx: 20 })
    expect(large.advanceWidth).toBeCloseTo(small.advanceWidth * 2)
  })

  it('returns ascent as 80% of sizePx', () => {
    const metrics = fallbackMeasureText('x', font)
    expect(metrics.ascent).toBeCloseTo(16 * 0.8)
  })

  it('returns descent as 20% of sizePx', () => {
    const metrics = fallbackMeasureText('x', font)
    expect(metrics.descent).toBeCloseTo(16 * 0.2)
  })

  it('returns lineGap as 10% of sizePx', () => {
    const metrics = fallbackMeasureText('x', font)
    expect(metrics.lineGap).toBeCloseTo(16 * 0.1)
  })

  it('produces finite values for any non-empty input', () => {
    const metrics = fallbackMeasureText('日本語テキスト', { ...font, sizePx: 24 })
    expect(Number.isFinite(metrics.advanceWidth)).toBe(true)
    expect(Number.isFinite(metrics.ascent)).toBe(true)
    expect(Number.isFinite(metrics.descent)).toBe(true)
    expect(Number.isFinite(metrics.lineGap)).toBe(true)
    expect(metrics.advanceWidth).toBeGreaterThan(0)
  })
})

describe('fullwidth text', () => {
  const font = {
    family: 'Roboto',
    fallbackChain: ['sans-serif'],
    weight: 400 as const,
    style: 'normal' as const,
    sizePx: 16,
  }

  // A uniform per-character ratio is not an approximation of Japanese, it is
  // the wrong model: a kana occupies a full em where a Latin letter occupies
  // about half of one. The agent-facing digest and SVG are laid out with this
  // measurer, so a canvas written in Japanese came back with line breaks and
  // a `truncated` verdict computed from widths roughly half the truth.
  it('charges a fullwidth character a full em', () => {
    expect(fallbackMeasureText('あ', font).advanceWidth).toBeCloseTo(16, 5)
    expect(fallbackMeasureText('日本語', font).advanceWidth).toBeCloseTo(48, 5)
  })

  it('still charges a Latin character about half an em', () => {
    const perChar = fallbackMeasureText('abcdefghij', font).advanceWidth / 10
    expect(perChar).toBeGreaterThan(16 * 0.4)
    expect(perChar).toBeLessThan(16 * 0.7)
  })

  it('adds the two up for mixed text', () => {
    // 3 fullwidth + 3 Latin.
    const mixed = fallbackMeasureText('日本語abc', font).advanceWidth
    const latin = fallbackMeasureText('abc', font).advanceWidth
    expect(mixed).toBeCloseTo(48 + latin, 5)
  })
})
