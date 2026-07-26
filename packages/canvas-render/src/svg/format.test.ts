import { describe, expect, it } from 'vitest'
import { escapeXmlAttr, escapeXmlText, formatCoord } from './format.js'

describe('formatCoord', () => {
  it('rounds to the fixed decimal precision and strips trailing zeros', () => {
    expect(formatCoord(1.23456)).toBe('1.235')
    expect(formatCoord(2)).toBe('2')
    expect(formatCoord(2.1)).toBe('2.1')
  })

  it('normalizes negative zero to zero', () => {
    expect(formatCoord(-0)).toBe('0')
    expect(formatCoord(0 * -1)).toBe('0')
  })

  it('rejects non-finite input', () => {
    expect(() => formatCoord(Number.NaN)).toThrow()
    expect(() => formatCoord(Number.POSITIVE_INFINITY)).toThrow()
    expect(() => formatCoord(Number.NEGATIVE_INFINITY)).toThrow()
  })

  it('does not use locale-dependent formatting for large numbers', () => {
    // toLocaleString would insert a thousands separator in en-US.
    expect(formatCoord(1234.5)).toBe('1234.5')
  })
})

describe('escapeXmlText', () => {
  it('escapes & < > in text content', () => {
    expect(escapeXmlText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
  })

  it('strips XML-forbidden control characters', () => {
    // XML 1.0 permits only #x9, #xA, #xD, and #x20-... among C0 controls.
    expect(escapeXmlText('a\x00b\x01c\x08d')).toBe('abcd')
    expect(escapeXmlText('keep\ttab\nand\rreturn')).toBe('keep\ttab\nand\rreturn')
  })

  it('strips lone (unpaired) surrogates', () => {
    expect(escapeXmlText('a\uD800b')).toBe('ab')
    expect(escapeXmlText('a\uDC00b')).toBe('ab')
    // A valid surrogate pair (an astral character) is preserved.
    expect(escapeXmlText('a😀b')).toBe('a😀b')
  })
})

describe('escapeXmlAttr', () => {
  it('escapes & < > " \' in attribute values', () => {
    expect(escapeXmlAttr(`a & "b" < 'c' >`)).toBe('a &amp; &quot;b&quot; &lt; &apos;c&apos; &gt;')
  })

  it('strips XML-forbidden control characters and lone surrogates', () => {
    expect(escapeXmlAttr('a\x00\uD800b')).toBe('ab')
  })
})
