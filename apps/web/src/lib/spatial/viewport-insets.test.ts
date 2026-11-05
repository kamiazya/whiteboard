// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { insetsClearingCorners, insetsFromCovers } from './viewport-insets.js'

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

describe('insetsClearingCorners', () => {
  // A portrait tablet: the overview card sits in the bottom-right corner above the dock.
  const tablet = { left: 0, top: 0, right: 820, bottom: 1086 }
  const base = { top: 50, bottom: 70, left: 0, right: 0 }
  const minimap = { left: 645, top: 960, right: 803, bottom: 1070 }

  it('keeps fitted content off a corner card by giving up the cheaper edge', () => {
    // Clearing its top costs 126px of height (12%); clearing its left 175px of width (21%).
    expect(insetsClearingCorners(tablet, [minimap], base)).toEqual({ ...base, bottom: 126 })
  })

  it('clears a corner card on a wide root by giving up width instead', () => {
    const wide = { left: 0, top: 0, right: 1600, bottom: 600 }
    const card = { left: 1400, top: 400, right: 1584, bottom: 584 }
    expect(insetsClearingCorners(wide, [card], base)).toEqual({ ...base, right: 200 })
  })

  it('leaves the insets alone when a card already sits inside them', () => {
    const inDock = { left: 645, top: 1030, right: 803, bottom: 1070 }
    expect(insetsClearingCorners(tablet, [inDock], { ...base, bottom: 70 })).toEqual({
      ...base,
      bottom: 70,
    })
  })

  it('ignores a card outside the root', () => {
    expect(
      insetsClearingCorners(tablet, [{ left: 900, top: 0, right: 1000, bottom: 100 }], base),
    ).toEqual(base)
  })
})
