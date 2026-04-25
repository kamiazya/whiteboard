import { describe, expect, it } from 'vitest'
import { estimateTextWidth } from './estimate-text-width.js'
import { wrapTextToWidth } from './wrap-text-to-width.js'

describe('wrapTextToWidth', () => {
  it('case 62', () => {
    const result = wrapTextToWidth('hello', 500, 20)
    expect(result).toEqual(['hello'])
  })

  it('case 63', () => {
    expect(wrapTextToWidth('', 500, 20)).toEqual([''])
  })

  it('case 64', () => {
    const text = 'the quick brown fox jumps over the lazy dog'
    const lines = wrapTextToWidth(text, 150, 20)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(estimateTextWidth(line, 20)).toBeLessThanOrEqual(150)
      expect(line).toBe(line.trim())
    }
    expect(lines.join(' ')).toBe(text)
  })

  it('case 65', () => {
    const text = 'ＦＵＬＬＷＩＤＴＨＦＬＯＷＴＥＳＴ'
    const lines = wrapTextToWidth(text, 100, 20)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(estimateTextWidth(line, 20)).toBeLessThanOrEqual(100)
    }
    expect(lines.join('')).toBe(text)
  })

  it('case 66', () => {
    const text = 'supercalifragilisticexpialidocious'
    const lines = wrapTextToWidth(text, 80, 20)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(estimateTextWidth(line, 20)).toBeLessThanOrEqual(80)
    }
    expect(lines.join('')).toBe(text)
  })

  it('case 67', () => {
    const text = 'box_with_label ＦＩＸＥＳ ＷＲＡＰ'
    const lines = wrapTextToWidth(text, 120, 20)
    for (const line of lines) {
      expect(estimateTextWidth(line, 20)).toBeLessThanOrEqual(120)
    }
    expect(lines.length).toBeGreaterThan(1)
  })

  it('case 68', () => {
    const text = 'line1\nline2 is longer than box'
    const lines = wrapTextToWidth(text, 120, 20)
    expect(lines[0]).toBe('line1')
    expect(lines.length).toBeGreaterThanOrEqual(2)
  })

  it('case 69', () => {
    const lines = wrapTextToWidth('abc', 0, 20)
    expect(lines).toEqual(['a', 'b', 'c'])
  })
})
