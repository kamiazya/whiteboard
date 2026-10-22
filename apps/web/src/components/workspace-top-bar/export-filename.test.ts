// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { sanitizeExportFilenameBase } from './export-filename'

describe('sanitizeExportFilenameBase', () => {
  it('replaces filesystem-unsafe characters with a hyphen', () => {
    expect(sanitizeExportFilenameBase('a\\b/c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
  })

  it('leaves an already-safe name untouched', () => {
    expect(sanitizeExportFilenameBase('my-canvas_v2')).toBe('my-canvas_v2')
  })

  // The download dialog shows the name it was handed: a control character, or
  // a bidi override that reorders what follows it (`invoice\u202Efdp.exe`
  // displays as `invoiceexe.pdf`), would show one name and save another.
  it.each([
    ['NUL', 0x00],
    ['the last C0 control', 0x1f],
    ['DEL', 0x7f],
    ['the first C1 control', 0x80],
    ['the last C1 control', 0x9f],
    ['LEFT-TO-RIGHT EMBEDDING', 0x202a],
    ['RIGHT-TO-LEFT OVERRIDE', 0x202e],
    ['LEFT-TO-RIGHT ISOLATE', 0x2066],
    ['POP DIRECTIONAL ISOLATE', 0x2069],
    ['ARABIC LETTER MARK', 0x061c],
    ['LEFT-TO-RIGHT MARK', 0x200e],
    ['RIGHT-TO-LEFT MARK', 0x200f],
  ])('replaces %s with a hyphen', (_name, codePoint) => {
    expect(sanitizeExportFilenameBase(`a${String.fromCodePoint(codePoint)}b`)).toBe('a-b')
  })

  it('keeps the characters either side of each replaced range', () => {
    const neighbours = [
      0x20, 0x7e, 0xa0, 0x061b, 0x061d, 0x200d, 0x2010, 0x2029, 0x202f, 0x2065, 0x206a,
    ]
    const name = String.fromCodePoint(...neighbours)
    expect(sanitizeExportFilenameBase(name)).toBe(name)
  })
})
