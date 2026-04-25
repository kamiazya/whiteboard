import { describe, expect, it } from 'vitest'
import { estimateTextWidth } from './estimate-text-width.js'

describe('estimateTextWidth', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTextWidth('')).toBe(0)
  })

  it('uses fontSize*0.55*3 for three ASCII characters', () => {
    // fontSize=20, ratio=0.55, 3 chars → 33
    expect(estimateTextWidth('ABC')).toBe(33)
  })

  it('uses fontSize*1.0*3 for three wide characters', () => {
    // fontSize=20, ratio=1.0, 3 chars → 60
    expect(estimateTextWidth('한글어')).toBe(60)
  })

  it('adds ASCII and wide characters independently in mixed text', () => {
    // "A한" -> 11 + 20 = 31
    expect(estimateTextWidth('A한')).toBe(31)
  })

  it('treats full-width Latin characters as wide', () => {
    expect(estimateTextWidth('ＡＢ')).toBe(40)
    expect(estimateTextWidth('ＸＹ')).toBe(40)
  })

  it('treats Hangul as wide', () => {
    expect(estimateTextWidth('한국')).toBe(40)
  })

  it('treats emoji as wide', () => {
    // 🎉 is one code point but encoded as a surrogate pair.
    expect(estimateTextWidth('🎉')).toBe(20)
  })

  it('treats full-width punctuation as wide', () => {
    expect(estimateTextWidth('！＠')).toBe(40)
  })

  it('accepts a custom fontSize', () => {
    // fontSize=10, ASCII ratio=0.55 → 5.5 per char, 2 chars → 11
    expect(estimateTextWidth('AB', 10)).toBe(11)
    // Wide characters at fontSize=40 -> 40 per char, 2 chars -> 80
    expect(estimateTextWidth('한국', 40)).toBe(80)
  })

  it('treats ASCII digits and symbols as narrow', () => {
    expect(estimateTextWidth('123')).toBe(33)
    expect(estimateTextWidth('!@#')).toBe(33)
  })

  it('treats ASCII space as narrow', () => {
    expect(estimateTextWidth('A B')).toBe(33) // 11*3
  })

  // Refine ASCII character classes to improve accuracy. Virgil makes i/l/I/|
  // especially narrow and M/W especially wide.
  describe('refined ASCII character classes', () => {
    it('treats i / l / I / | as very narrow', () => {
      // These should calculate narrower than typical ASCII.
      expect(estimateTextWidth('iii')).toBeLessThan(estimateTextWidth('xxx'))
      expect(estimateTextWidth('lll')).toBeLessThan(estimateTextWidth('ooo'))
      expect(estimateTextWidth('III')).toBeLessThan(estimateTextWidth('HHH'))
      expect(estimateTextWidth('|||')).toBeLessThan(estimateTextWidth('nnn'))
    })

    it('treats M / W as very wide', () => {
      expect(estimateTextWidth('MMM')).toBeGreaterThan(estimateTextWidth('xxx'))
      expect(estimateTextWidth('WWW')).toBeGreaterThan(estimateTextWidth('ooo'))
    })

    it('keeps very narrow i at less than half the width of very wide M', () => {
      // i: 0.3 * 20 = 6, M: 0.9 * 20 = 18
      expect(estimateTextWidth('i') * 2).toBeLessThanOrEqual(estimateTextWidth('M'))
    })

    it('keeps ordinary ASCII words at narrow*length', () => {
      // Backward-compatible case: ordinary words keep the previous values.
      expect(estimateTextWidth('pasta')).toBe(55) // 5 * 11
      expect(estimateTextWidth('ocean')).toBe(55)
    })
  })
})
