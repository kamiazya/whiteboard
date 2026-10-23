// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { insetsFromCovers } from './viewport-insets.js'

const root = { left: 0, top: 0, right: 400, bottom: 600 }

describe('insetsFromCovers', () => {
  it('reads a bottom sheet as a bottom inset of its height', () => {
    expect(insetsFromCovers(root, [{ left: 0, top: 330, right: 400, bottom: 600 }])).toEqual({
      top: 0,
      bottom: 270,
      left: 0,
      right: 0,
    })
  })

  it('reads a full-height strip on the right as a right inset', () => {
    expect(insetsFromCovers(root, [{ left: 300, top: 0, right: 400, bottom: 600 }]).right).toBe(100)
  })

  it('clips a cover that reaches past the root to the part inside it', () => {
    expect(insetsFromCovers(root, [{ left: -50, top: 500, right: 450, bottom: 900 }]).bottom).toBe(
      100,
    )
  })

  it('ignores a card floating in the middle, which hides a spot and not a strip', () => {
    const zero = { top: 0, bottom: 0, left: 0, right: 0 }
    expect(insetsFromCovers(root, [{ left: 100, top: 100, right: 200, bottom: 200 }])).toEqual(zero)
  })

  it('ignores a cover over the whole root, which leaves no area to keep anything in', () => {
    const zero = { top: 0, bottom: 0, left: 0, right: 0 }
    expect(insetsFromCovers(root, [{ left: 0, top: 0, right: 400, bottom: 600 }])).toEqual(zero)
  })

  it('ignores a cover that does not touch the root', () => {
    const zero = { top: 0, bottom: 0, left: 0, right: 0 }
    expect(insetsFromCovers(root, [{ left: 400, top: 0, right: 700, bottom: 600 }])).toEqual(zero)
  })

  it('takes the larger of two covers on one edge', () => {
    const covers = [
      { left: 0, top: 500, right: 400, bottom: 600 },
      { left: 0, top: 400, right: 400, bottom: 600 },
    ]
    expect(insetsFromCovers(root, covers).bottom).toBe(200)
  })
})
