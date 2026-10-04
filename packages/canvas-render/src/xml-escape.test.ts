import { describe, expect, it } from 'vitest'
import { escapeXmlAttr, escapeXmlText } from './xml-escape.js'

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
