import { describe, expect, it } from 'vitest'
import { fallbackMeasureText } from './fallback-measure.js'

describe('fallbackMeasureText', () => {
  const font = { sizePx: 16, family: 'sans-serif', weight: 400 as const, style: 'normal' as const }

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
