import { describe, expect, it } from 'vitest'
import type { FontDescriptor } from '../measure.js'
import { createFakeMeasure, createFixedMeasure } from './fake-measure.js'

const FONT: FontDescriptor = {
  family: 'x',
  fallbackChain: [],
  sizePx: 20,
  weight: 400,
  style: 'normal',
}

describe('createFakeMeasure', () => {
  it('charges each character a fraction of the font size and scales the box with it', () => {
    expect(createFakeMeasure()('abcd', FONT)).toEqual({
      advanceWidth: 4 * 0.6 * 20,
      ascent: 16,
      descent: 4,
      lineGap: 2,
    })
    expect(createFakeMeasure(0.5)('ab', FONT).advanceWidth).toBe(20)
  })
})

describe('createFixedMeasure', () => {
  it('answers one width for every string when the advance is a number', () => {
    const measure = createFixedMeasure({ advance: 30, ascent: 10, descent: 2 })
    const expected = { advanceWidth: 30, ascent: 10, descent: 2, lineGap: 0 }
    expect(measure('', FONT)).toEqual(expected)
    expect(measure('a long line of text', { ...FONT, sizePx: 99 })).toEqual(expected)
  })

  it('derives the width from the text when the advance is a function', () => {
    const measure = createFixedMeasure({
      advance: (text) => text.length * 8,
      ascent: 12,
      descent: 4,
      lineGap: 3,
    })
    expect(measure('hello', FONT)).toEqual({ advanceWidth: 40, ascent: 12, descent: 4, lineGap: 3 })
    expect(measure('', FONT).advanceWidth).toBe(0)
  })
})
