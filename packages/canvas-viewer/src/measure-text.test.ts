// Runs under the canvas-viewer-node project (no `document` global), so
// createBrowserMeasureText's getContext() throws internally and falls back
// to the ratio-measurer — this is exactly the path that lets the jsdom
// project (no real Canvas 2D backend either) mount the viewer.
import { describe, expect, it } from 'vitest'
import { createBrowserMeasureText } from './measure-text.js'

const font = {
  family: 'Roboto',
  fallbackChain: ['sans-serif'],
  weight: 400,
  style: 'normal' as const,
  sizePx: 16,
}

describe('createBrowserMeasureText (fallback path)', () => {
  it('measures an empty string as advanceWidth 0', () => {
    const measure = createBrowserMeasureText()
    expect(measure('', font).advanceWidth).toBe(0)
  })

  it('returns finite, non-negative metrics for non-empty text', () => {
    const measure = createBrowserMeasureText()
    const metrics = measure('hello world', font)
    for (const value of Object.values(metrics)) {
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
  })

  it('scales advanceWidth linearly with sizePx', () => {
    const measure = createBrowserMeasureText()
    const small = measure('hello', { ...font, sizePx: 16 })
    const large = measure('hello', { ...font, sizePx: 32 })
    expect(large.advanceWidth).toBeCloseTo(small.advanceWidth * 2, 5)
  })
})
