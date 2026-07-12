import { describe, expect, it } from 'vitest'
import { deriveCopyName } from './derive-copy-name.js'

describe('deriveCopyName', () => {
  it('appends " (copy)" when no collision exists', () => {
    expect(deriveCopyName('Diagram', [])).toBe('Diagram (copy)')
  })

  it('appends " (copy 2)" when "(copy)" is already taken', () => {
    expect(deriveCopyName('Diagram', ['Diagram (copy)'])).toBe('Diagram (copy 2)')
  })

  it('keeps incrementing past multiple existing numbered copies', () => {
    expect(
      deriveCopyName('Diagram', ['Diagram (copy)', 'Diagram (copy 2)', 'Diagram (copy 3)']),
    ).toBe('Diagram (copy 4)')
  })

  it('does not collide with an unrelated numbered copy of a different base name', () => {
    expect(deriveCopyName('Diagram', ['Sketch (copy)', 'Sketch (copy 2)'])).toBe('Diagram (copy)')
  })

  it('fills a gap left by a renamed/deleted numbered copy rather than always picking the max+1', () => {
    // "Diagram (copy 2)" no longer exists (renamed away or deleted) — the next
    // duplicate should reuse that name instead of jumping to "(copy 4)".
    expect(deriveCopyName('Diagram', ['Diagram (copy)', 'Diagram (copy 3)'])).toBe(
      'Diagram (copy 2)',
    )
  })

  it('accepts a Set as well as an array for existing names', () => {
    expect(deriveCopyName('Diagram', new Set(['Diagram (copy)']))).toBe('Diagram (copy 2)')
  })
})
