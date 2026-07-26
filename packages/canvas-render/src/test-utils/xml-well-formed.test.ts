import { describe, expect, it } from 'vitest'
import { isWellFormedXmlFragment } from './xml-well-formed.js'

describe('isWellFormedXmlFragment', () => {
  it('accepts a well-formed fragment with escaped text and attributes', () => {
    expect(isWellFormedXmlFragment('<svg><text>a &amp; b</text></svg>')).toBe(true)
    expect(isWellFormedXmlFragment('<svg href="&amp;"/>')).toBe(true)
  })

  it('rejects mismatched tags', () => {
    expect(isWellFormedXmlFragment('<svg><g></svg></g>')).toBe(false)
  })

  it('rejects an unescaped & in text content', () => {
    expect(isWellFormedXmlFragment('<svg>a & b</svg>')).toBe(false)
  })

  it('rejects a bare & inside an attribute value', () => {
    expect(isWellFormedXmlFragment('<svg href="&"/>')).toBe(false)
  })

  it('rejects an unknown entity reference inside an attribute value', () => {
    expect(isWellFormedXmlFragment('<svg href="&unknown;"/>')).toBe(false)
  })

  it('accepts a properly escaped ampersand inside an attribute value', () => {
    expect(isWellFormedXmlFragment('<svg href="&amp;"/>')).toBe(true)
  })
})
