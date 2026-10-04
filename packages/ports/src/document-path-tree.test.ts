import { describe, expect, it } from 'vitest'
import { findDescendantPath, planSubtreeMove } from './document-path-tree.js'

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
