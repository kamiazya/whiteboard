import { describe, expect, it } from 'vitest'
import { deriveCopySlug } from './derive-copy-path.js'

describe('deriveCopySlug', () => {
  it('appends "-copy" when no collision exists', () => {
    expect(deriveCopySlug('diagram', [])).toBe('diagram-copy')
  })

  it('appends "-copy-2" when "-copy" is already taken', () => {
    expect(deriveCopySlug('diagram', ['diagram-copy'])).toBe('diagram-copy-2')
  })

  it('keeps incrementing past multiple existing numbered copies', () => {
    expect(deriveCopySlug('diagram', ['diagram-copy', 'diagram-copy-2', 'diagram-copy-3'])).toBe(
      'diagram-copy-4',
    )
  })

  it('does not collide with an unrelated numbered copy of a different base path', () => {
    expect(deriveCopySlug('diagram', ['sketch-copy', 'sketch-copy-2'])).toBe('diagram-copy')
  })

  it('produces a path containing only ASCII letters, digits, and hyphens', () => {
    expect(deriveCopySlug('diagram', [])).toMatch(/^[a-zA-Z0-9-]+$/)
  })
})
