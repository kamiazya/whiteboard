import { describe, expect, it } from 'vitest'
import { clampAdvance } from './measure.js'

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
