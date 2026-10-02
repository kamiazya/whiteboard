import { describe, expect, it } from 'vitest'
import { findDescendantPath, isSelfOrDescendant, planSubtreeMove } from './document-path-tree.js'

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

describe('planSubtreeMove', () => {
  const rows = [
    { id: 'a', path: 'design/a' },
    { id: 'b', path: 'design-system/b' },
  ]

  it('carries the folder being renamed and leaves a prefix-sharing sibling alone', () => {
    const plan = planSubtreeMove(rows, 'design', 'design-v2')
    expect(plan).toEqual({
      ok: true,
      moves: [{ id: 'a', from: 'design/a', path: 'design-v2/a' }],
    })
  })
})

describe('findDescendantPath', () => {
  it('ignores a sibling that shares the prefix', () => {
    const rows = [
      { id: 'a', path: 'design' },
      { id: 'b', path: 'design-system' },
    ]
    expect(findDescendantPath(rows, 'design')).toBeUndefined()
    expect(findDescendantPath([...rows, { id: 'c', path: 'design/x' }], 'design')).toBe('design/x')
  })
})
