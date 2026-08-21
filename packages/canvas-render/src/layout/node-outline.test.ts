import { describe, expect, it } from 'vitest'
import { nodeOutline, outlineContains, outlineEntryPoint } from './node-outline.js'

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

describe('nodeOutline — hexagon / parallelogram / cylinder', () => {
  it('hexagon: pointy-left-right six-gon, clockwise from the top-left corner, inset capped', () => {
    expect(nodeOutline('hexagon', box)).toEqual({
      kind: 'polygon',
      points: [
        { x: 35, y: 20 },
        { x: 85, y: 20 },
        { x: 110, y: 50 },
        { x: 85, y: 80 },
        { x: 35, y: 80 },
        { x: 10, y: 50 },
      ],
    })
    // A tall narrow box caps the inset at w/4 so the side points survive.
    expect(nodeOutline('hexagon', { x: 0, y: 0, w: 40, h: 200 })).toEqual({
      kind: 'polygon',
      points: [
        { x: 10, y: 0 },
        { x: 30, y: 0 },
        { x: 40, y: 100 },
        { x: 30, y: 200 },
        { x: 10, y: 200 },
        { x: 0, y: 100 },
      ],
    })
  })

  it('parallelogram: right-leaning skew, clockwise from the top-left vertex', () => {
    expect(nodeOutline('parallelogram', box)).toEqual({
      kind: 'polygon',
      points: [
        { x: 35, y: 20 },
        { x: 110, y: 20 },
        { x: 85, y: 80 },
        { x: 10, y: 80 },
      ],
    })
  })

  it('cylinder: bbox plus a capped lid radius, never more than a quarter of the height', () => {
    expect(nodeOutline('cylinder', box)).toEqual({
      kind: 'cylinder',
      x: 10,
      y: 20,
      w: 100,
      h: 60,
      ry: 10,
    })
    expect(nodeOutline('cylinder', { x: 0, y: 0, w: 100, h: 24 })).toEqual({
      kind: 'cylinder',
      x: 0,
      y: 0,
      w: 100,
      h: 24,
      ry: 6,
    })
  })

  it('containment: hexagon corner outside, cylinder body inside, cap regions honoured', () => {
    expect(outlineContains('hexagon', box, { x: 12, y: 22 })).toBe(false)
    expect(outlineContains('hexagon', box, { x: 60, y: 50 })).toBe(true)
    expect(outlineContains('parallelogram', box, { x: 12, y: 22 })).toBe(false)
    expect(outlineContains('cylinder', box, { x: 60, y: 50 })).toBe(true)
    // Above the top cap's crown is outside; the crown's own center is inside.
    expect(outlineContains('cylinder', box, { x: 12, y: 21 })).toBe(false)
    expect(outlineContains('cylinder', box, { x: 60, y: 21 })).toBe(true)
  })
})

describe('outlineEntryPoint — where a segment entering the box first meets the outline', () => {
  it('ellipse: a horizontal approach lands on the rim, not the bbox border', () => {
    // Approaching the box's left edge midpoint from the left: the rim IS
    // the border there (tangent point), so the point stays put.
    const tangent = outlineEntryPoint('ellipse', box, { x: -40, y: 50 }, { x: 10, y: 50 })
    expect(tangent.x).toBeCloseTo(10, 3)
    expect(tangent.y).toBeCloseTo(50, 3)
    // Approaching a corner-adjacent border point: the rim sits INSIDE the
    // bbox along the approach line, so the entry point is pulled inward.
    const pulled = outlineEntryPoint('ellipse', box, { x: 60, y: -40 }, { x: 85, y: 20 })
    expect(outlineContains('ellipse', box, pulled)).toBe(true)
    expect(pulled.y).toBeGreaterThan(20)
    // The returned point is ON the boundary: nudging back along the
    // approach direction leaves the outline.
    expect(outlineContains('ellipse', box, { x: pulled.x - 0.5, y: pulled.y - 1.2 })).toBe(false)
  })

  it('diamond: a corner-ward approach is pulled to the sloped side', () => {
    const pulled = outlineEntryPoint('diamond', box, { x: -40, y: -10 }, { x: 20, y: 26 })
    expect(outlineContains('diamond', box, pulled)).toBe(true)
    expect(pulled.x).toBeGreaterThan(20)
  })

  it('is total: a segment that never enters the outline returns the terminal unchanged', () => {
    const kept = outlineEntryPoint('ellipse', box, { x: -40, y: 20 }, { x: 10, y: 20 })
    expect(kept).toEqual({ x: 10, y: 20 })
    expect(
      outlineEntryPoint(
        'ellipse',
        { x: Number.NaN, y: 0, w: 1, h: 1 },
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ),
    ).toEqual({ x: 1, y: 1 })
  })
})
