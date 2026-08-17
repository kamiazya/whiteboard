import { describe, expect, it } from 'vitest'
import { deriveNewCanvasPath } from './derive-new-canvas-path.js'

describe('deriveNewCanvasPath', () => {
  it('returns "untitled" when the set is empty', () => {
    expect(deriveNewCanvasPath([])).toBe('untitled')
  })

  it('returns "untitled-2" when "untitled" is already taken', () => {
    expect(deriveNewCanvasPath(['untitled'])).toBe('untitled-2')
  })

  it('returns "untitled-3" when "untitled" and "untitled-2" are taken', () => {
    expect(deriveNewCanvasPath(['untitled', 'untitled-2'])).toBe('untitled-3')
  })

  it('fills a gap instead of skipping past it', () => {
    expect(deriveNewCanvasPath(['untitled', 'untitled-3'])).toBe('untitled-2')
  })
})
