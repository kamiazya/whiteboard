// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { deriveNewDocumentPath } from './derive-new-document-path.js'

describe('deriveNewDocumentPath', () => {
  it('returns "untitled" when the set is empty', () => {
    expect(deriveNewDocumentPath([])).toBe('untitled')
  })

  it('returns "untitled-2" when "untitled" is already taken', () => {
    expect(deriveNewDocumentPath(['untitled'])).toBe('untitled-2')
  })

  it('returns "untitled-3" when "untitled" and "untitled-2" are taken', () => {
    expect(deriveNewDocumentPath(['untitled', 'untitled-2'])).toBe('untitled-3')
  })

  it('fills a gap instead of skipping past it', () => {
    expect(deriveNewDocumentPath(['untitled', 'untitled-3'])).toBe('untitled-2')
  })
})
