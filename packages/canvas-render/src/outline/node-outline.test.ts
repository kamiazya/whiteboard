import { describe, expect, it } from 'vitest'
import { BUNDLED_SHAPE_TABLE, nodeOutline } from './node-outline.js'

const box = { x: 10, y: 20, w: 100, h: 60 }

describe('nodeOutline — the ONE producer of non-rect node silhouettes', () => {
  it('ellipse: inscribed in the bbox', () => {
    expect(nodeOutline('visual.ellipse', box)).toEqual({
      kind: 'ellipse',
      cx: 60,
      cy: 50,
      rx: 50,
      ry: 30,
    })
  })

  it('diamond: edge-midpoint polygon, clockwise from the top vertex', () => {
    expect(nodeOutline('visual.diamond', box)).toEqual({
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
    expect(nodeOutline('visual.ellipse', { x: Number.NaN, y: 0, w: 10, h: 10 })).toBeNull()
    expect(
      nodeOutline('visual.diamond', { x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 10 }),
    ).toBeNull()
  })

  it('degenerate boxes still produce an outline (valid, possibly invisible geometry)', () => {
    expect(nodeOutline('visual.ellipse', { x: 0, y: 0, w: 0, h: 0 })).toEqual({
      kind: 'ellipse',
      cx: 0,
      cy: 0,
      rx: 0,
      ry: 0,
    })
  })
})

describe('nodeOutline — hexagon / parallelogram / cylinder', () => {
  it('hexagon: pointy-left-right six-gon, clockwise from the top-left corner, inset capped', () => {
    expect(nodeOutline('visual.hexagon', box)).toEqual({
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
    // A tall narrow box takes the w/4 term; the h/2 cap does not bind.
    expect(nodeOutline('visual.hexagon', { x: 0, y: 0, w: 40, h: 200 })).toEqual({
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
    // A wide flat box is where the h/2 cap binds, keeping the polygon convex.
    expect(nodeOutline('visual.hexagon', { x: 0, y: 0, w: 400, h: 20 })).toEqual({
      kind: 'polygon',
      points: [
        { x: 10, y: 0 },
        { x: 390, y: 0 },
        { x: 400, y: 10 },
        { x: 390, y: 20 },
        { x: 10, y: 20 },
        { x: 0, y: 10 },
      ],
    })
  })

  it('parallelogram: right-leaning skew, clockwise from the top-left vertex', () => {
    expect(nodeOutline('visual.parallelogram', box)).toEqual({
      kind: 'polygon',
      points: [
        { x: 35, y: 20 },
        { x: 110, y: 20 },
        { x: 85, y: 80 },
        { x: 10, y: 80 },
      ],
    })
  })

  it('octagon: a rect with symmetric corner cuts, off the SMALLER dimension', () => {
    // h is the smaller dimension here, so the cut is 15 — and the flat
    // vertical edges it leaves are what a reader tells apart from the
    // hexagon's points, which at this box run 25px in from each end.
    expect(nodeOutline('visual.octagon', box)).toEqual({
      kind: 'polygon',
      points: [
        { x: 25, y: 20 },
        { x: 95, y: 20 },
        { x: 110, y: 35 },
        { x: 110, y: 65 },
        { x: 95, y: 80 },
        { x: 25, y: 80 },
        { x: 10, y: 65 },
        { x: 10, y: 35 },
      ],
    })
    // A tall narrow box takes the same cut off its WIDTH, so the silhouette
    // stays an octagon instead of collapsing the way a width-only term
    // would. The hexagon's own case at this proportion is the contrast.
    expect(nodeOutline('visual.octagon', { x: 0, y: 0, w: 40, h: 200 })).toEqual({
      kind: 'polygon',
      points: [
        { x: 10, y: 0 },
        { x: 30, y: 0 },
        { x: 40, y: 10 },
        { x: 40, y: 190 },
        { x: 30, y: 200 },
        { x: 10, y: 200 },
        { x: 0, y: 190 },
        { x: 0, y: 10 },
      ],
    })
  })

  it('cylinder: bbox plus a capped lid radius, never more than a quarter of the height', () => {
    expect(nodeOutline('visual.cylinder', box)).toEqual({
      kind: 'cylinder',
      x: 10,
      y: 20,
      w: 100,
      h: 60,
      ry: 10,
    })
    expect(nodeOutline('visual.cylinder', { x: 0, y: 0, w: 100, h: 24 })).toEqual({
      kind: 'cylinder',
      x: 0,
      y: 0,
      w: 100,
      h: 24,
      ry: 6,
    })
  })
})

describe('the bundled table and unsupported shapes', () => {
  it('every bundled silhouette draws an outline for an ordinary box', () => {
    const ids = Object.keys(BUNDLED_SHAPE_TABLE)
    expect(ids.length).toBeGreaterThanOrEqual(5)
    for (const id of ids) expect(nodeOutline(id, box), id).not.toBeNull()
  })

  it('an unsupported runtime shape value degrades to null, never a throw', () => {
    const bogus = 'blob' as unknown as Parameters<typeof nodeOutline>[0]
    expect(nodeOutline(bogus, box)).toBeNull()
  })
})
