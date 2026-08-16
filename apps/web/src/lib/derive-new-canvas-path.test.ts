import { describe, expect, it } from 'vitest'
import { deriveNewCanvasSlug } from './derive-new-canvas-path.js'

describe('deriveNewCanvasSlug', () => {
  it('returns "untitled" when the set is empty', () => {
    expect(deriveNewCanvasSlug([])).toBe('untitled')
  })

  it('returns "untitled-2" when "untitled" is already taken', () => {
    expect(deriveNewCanvasSlug(['untitled'])).toBe('untitled-2')
  })

  it('returns "untitled-3" when "untitled" and "untitled-2" are taken', () => {
    expect(deriveNewCanvasSlug(['untitled', 'untitled-2'])).toBe('untitled-3')
  })

  it('fills a gap instead of skipping past it', () => {
    expect(deriveNewCanvasSlug(['untitled', 'untitled-3'])).toBe('untitled-2')
  })
})
