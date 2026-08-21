import { describe, expect, it } from 'vitest'
import { nodeOutline, outlineContains } from './node-outline.js'

const box = { x: 10, y: 20, w: 100, h: 60 }

describe('nodeOutline — the ONE producer of non-rect node silhouettes', () => {
  it('ellipse: inscribed in the bbox', () => {
    expect(nodeOutline('ellipse', box)).toEqual({
      kind: 'ellipse',
      cx: 60,
      cy: 50,
      rx: 50,
      ry: 30,
    })
  })

  it('diamond: edge-midpoint polygon, clockwise from the top vertex', () => {
    expect(nodeOutline('diamond', box)).toEqual({
      kind: 'polygon',
      points: [
        { x: 60, y: 20 },
        { x: 110, y: 50 },
        { x: 60, y: 80 },
        { x: 10, y: 50 },
      ],
    })
  })

  it('is total: a non-finite bbox yields null instead of throwing', () => {
    expect(nodeOutline('ellipse', { x: Number.NaN, y: 0, w: 10, h: 10 })).toBeNull()
    expect(nodeOutline('diamond', { x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 10 })).toBeNull()
  })

  it('degenerate boxes still produce an outline (valid, possibly invisible geometry)', () => {
    expect(nodeOutline('ellipse', { x: 0, y: 0, w: 0, h: 0 })).toEqual({
      kind: 'ellipse',
      cx: 0,
      cy: 0,
      rx: 0,
      ry: 0,
    })
  })
})

describe('outlineContains — the hit-test half of the same producer', () => {
  it('ellipse: center inside, bbox corner outside', () => {
    expect(outlineContains('ellipse', box, { x: 60, y: 50 })).toBe(true)
    // A bbox corner is outside the inscribed ellipse — exactly the visual-
    // accuracy gap this function exists to close over plain box containment.
    expect(outlineContains('ellipse', box, { x: 12, y: 22 })).toBe(false)
  })

  it('diamond: center inside, corner outside, boundary-adjacent points behave', () => {
    expect(outlineContains('diamond', box, { x: 60, y: 50 })).toBe(true)
    expect(outlineContains('diamond', box, { x: 14, y: 24 })).toBe(false)
    expect(outlineContains('diamond', box, { x: 60, y: 21 })).toBe(true)
  })

  it('is total on non-finite input (never throws, answers false)', () => {
    expect(outlineContains('ellipse', box, { x: Number.NaN, y: 0 })).toBe(false)
  })
})
