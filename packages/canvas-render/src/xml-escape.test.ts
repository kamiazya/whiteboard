import { describe, expect, it } from 'vitest'
import { escapeXmlAttr, escapeXmlText } from './xml-escape.js'

// XML 1.0 §2.2 `Char` admits exactly these three of the 32 C0 controls,
// written out as code points so the oracle shares nothing with the regex
// under test.
const XML_CHAR_C0 = new Set([0x09, 0x0a, 0x0d])
const C0_CONTROLS = Array.from({ length: 0x20 }, (_, codePoint) => ({
  codePoint,
  hex: codePoint.toString(16).toUpperCase().padStart(4, '0'),
}))

describe.each([
  ['escapeXmlText', escapeXmlText],
  ['escapeXmlAttr', escapeXmlAttr],
])('%s over every C0 control', (_name, escapeXml) => {
  it.each(C0_CONTROLS)('keeps U+$hex exactly when XML 1.0 Char admits it', ({ codePoint }) => {
    const ch = String.fromCodePoint(codePoint)
    expect(escapeXml(`a${ch}b`)).toBe(XML_CHAR_C0.has(codePoint) ? `a${ch}b` : 'ab')
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

  it('strips the XML noncharacters U+FFFE and U+FFFF', () => {
    // XML 1.0 forbids these noncharacters; leaving them in would let
    // escapeXmlText emit malformed XML.
    expect(escapeXmlText('a￾b￿c')).toBe('abc')
  })
})

describe('escapeXmlAttr', () => {
  it('escapes & < > " \' in attribute values', () => {
    expect(escapeXmlAttr(`a & "b" < 'c' >`)).toBe('a &amp; &quot;b&quot; &lt; &apos;c&apos; &gt;')
  })

  it('strips XML-forbidden control characters and lone surrogates', () => {
    expect(escapeXmlAttr('a\x00\uD800b')).toBe('ab')
  })

  it('strips the XML noncharacters U+FFFE and U+FFFF', () => {
    expect(escapeXmlAttr('a￾b￿c')).toBe('abc')
  })
})
