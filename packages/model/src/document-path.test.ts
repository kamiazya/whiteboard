import { describe, expect, it } from 'vitest'
import { isSelfOrDescendant, rebasePath } from './document-path.js'

describe('isSelfOrDescendant', () => {
  it('holds for the ancestor itself and for anything below it', () => {
    expect(isSelfOrDescendant('design', 'design')).toBe(true)
    expect(isSelfOrDescendant('design/x', 'design')).toBe(true)
    expect(isSelfOrDescendant('design/x/y', 'design')).toBe(true)
  })

  it('does not hold for a sibling that merely shares the ancestor as a prefix', () => {
    expect(isSelfOrDescendant('design-system', 'design')).toBe(false)
    expect(isSelfOrDescendant('design-v2/x', 'design')).toBe(false)
  })

  it('does not hold for an ancestor of the path', () => {
    expect(isSelfOrDescendant('design', 'design/x')).toBe(false)
  })
})

describe('rebasePath', () => {
  it('moves the root itself and everything below it', () => {
    expect(rebasePath('design', 'design', 'ui')).toBe('ui')
    expect(rebasePath('design/x', 'design', 'ui')).toBe('ui/x')
    expect(rebasePath('design/x/y', 'design', 'ui/deep')).toBe('ui/deep/x/y')
  })

  it('leaves a sibling that shares the prefix, and an unrelated path, where they are', () => {
    expect(rebasePath('design-system/x', 'design', 'ui')).toBe('design-system/x')
    expect(rebasePath('other', 'design', 'ui')).toBe('other')
    expect(rebasePath('design', 'design/x', 'ui')).toBe('design')
  })
})
