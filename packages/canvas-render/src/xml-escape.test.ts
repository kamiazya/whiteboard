import { describe, expect, it } from 'vitest'
import { stripXmlInvalidChars } from './xml-escape.js'

// XML 1.0 §2.2 `Char` admits exactly these three of the 32 C0 controls,
// written out as code points so the oracle shares nothing with the regex
// under test.
const XML_CHAR_C0 = new Set([0x09, 0x0a, 0x0d])
const C0_CONTROLS = Array.from({ length: 0x20 }, (_, codePoint) => ({
  codePoint,
  hex: codePoint.toString(16).toUpperCase().padStart(4, '0'),
}))

describe('stripXmlInvalidChars', () => {
  it.each(C0_CONTROLS)('keeps U+$hex exactly when XML 1.0 Char admits it', ({ codePoint }) => {
    const ch = String.fromCodePoint(codePoint)
    expect(stripXmlInvalidChars(`a${ch}b`)).toBe(XML_CHAR_C0.has(codePoint) ? `a${ch}b` : 'ab')
  })

  it('strips XML-forbidden control characters and keeps tab, newline and return', () => {
    expect(stripXmlInvalidChars('a\x00b\x01c\x08d')).toBe('abcd')
    expect(stripXmlInvalidChars('keep\ttab\nand\rreturn')).toBe('keep\ttab\nand\rreturn')
  })

  it('strips lone (unpaired) surrogates and keeps a valid pair', () => {
    expect(stripXmlInvalidChars('a\uD800b')).toBe('ab')
    expect(stripXmlInvalidChars('a\uDC00b')).toBe('ab')
    expect(stripXmlInvalidChars('a😀b')).toBe('a😀b')
  })

  it('strips the XML noncharacters U+FFFE and U+FFFF', () => {
    expect(stripXmlInvalidChars('a￾b￿c')).toBe('abc')
  })

  it('leaves markup characters for the core to escape', () => {
    expect(stripXmlInvalidChars(`a & "b" < 'c' >`)).toBe(`a & "b" < 'c' >`)
  })
})
