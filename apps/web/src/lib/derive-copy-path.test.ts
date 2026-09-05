// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { deriveCopyPath } from './derive-copy-path.js'

describe('deriveCopyPath', () => {
  it('appends "-copy" when no collision exists', () => {
    expect(deriveCopyPath('diagram', [])).toBe('diagram-copy')
  })

  it('appends "-copy-2" when "-copy" is already taken', () => {
    expect(deriveCopyPath('diagram', ['diagram-copy'])).toBe('diagram-copy-2')
  })

  it('keeps incrementing past multiple existing numbered copies', () => {
    expect(deriveCopyPath('diagram', ['diagram-copy', 'diagram-copy-2', 'diagram-copy-3'])).toBe(
      'diagram-copy-4',
    )
  })

  it('does not collide with an unrelated numbered copy of a different base path', () => {
    expect(deriveCopyPath('diagram', ['sketch-copy', 'sketch-copy-2'])).toBe('diagram-copy')
  })

  it('produces a path containing only ASCII letters, digits, and hyphens', () => {
    expect(deriveCopyPath('diagram', [])).toMatch(/^[a-zA-Z0-9-]+$/)
  })
})
