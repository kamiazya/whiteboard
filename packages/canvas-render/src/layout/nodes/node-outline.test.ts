import { describe, expect, it } from 'vitest'
import {
  nodeOutline,
  outlineContains,
  outlineContentBox,
  outlineEntryPoint,
} from './node-outline.js'

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

describe('outlineContains — the hit-test half of the same producer', () => {
  it('ellipse: center inside, bbox corner outside', () => {
    expect(outlineContains('visual.ellipse', box, { x: 60, y: 50 })).toBe(true)
    // A bbox corner is outside the inscribed ellipse — exactly the visual-
    // accuracy gap this function exists to close over plain box containment.
    expect(outlineContains('visual.ellipse', box, { x: 12, y: 22 })).toBe(false)
  })

  it('diamond: center inside, corner outside, boundary-adjacent points behave', () => {
    expect(outlineContains('visual.diamond', box, { x: 60, y: 50 })).toBe(true)
    expect(outlineContains('visual.diamond', box, { x: 14, y: 24 })).toBe(false)
    expect(outlineContains('visual.diamond', box, { x: 60, y: 21 })).toBe(true)
  })

  it('is total on non-finite input (never throws, answers false)', () => {
    expect(outlineContains('visual.ellipse', box, { x: Number.NaN, y: 0 })).toBe(false)
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

  it('containment: hexagon corner outside, cylinder body inside, cap regions honoured', () => {
    expect(outlineContains('visual.hexagon', box, { x: 12, y: 22 })).toBe(false)
    expect(outlineContains('visual.hexagon', box, { x: 60, y: 50 })).toBe(true)
    expect(outlineContains('visual.parallelogram', box, { x: 12, y: 22 })).toBe(false)
    expect(outlineContains('visual.cylinder', box, { x: 60, y: 50 })).toBe(true)
    // Above the top cap's crown is outside; the crown's own center is inside.
    expect(outlineContains('visual.cylinder', box, { x: 12, y: 21 })).toBe(false)
    expect(outlineContains('visual.cylinder', box, { x: 60, y: 21 })).toBe(true)
  })
})

describe('outlineEntryPoint — where a segment entering the box first meets the outline', () => {
  it('ellipse: a horizontal approach lands on the rim, not the bbox border', () => {
    // Approaching the box's left edge midpoint from the left: the rim IS
    // the border there (tangent point), so the point stays put.
    const tangent = outlineEntryPoint('visual.ellipse', box, { x: -40, y: 50 }, { x: 10, y: 50 })
    expect(tangent.x).toBeCloseTo(10, 3)
    expect(tangent.y).toBeCloseTo(50, 3)
    // Approaching a corner-adjacent border point: the rim sits INSIDE the
    // bbox along the approach line, so the entry point is pulled inward.
    const pulled = outlineEntryPoint('visual.ellipse', box, { x: 60, y: -40 }, { x: 85, y: 20 })
    expect(outlineContains('visual.ellipse', box, pulled)).toBe(true)
    expect(pulled.y).toBeGreaterThan(20)
    // The returned point is ON the boundary: nudging back along the
    // approach direction leaves the outline.
    expect(outlineContains('visual.ellipse', box, { x: pulled.x - 0.5, y: pulled.y - 1.2 })).toBe(
      false,
    )
  })

  it('diamond: a corner-ward approach is pulled to the sloped side', () => {
    const pulled = outlineEntryPoint('visual.diamond', box, { x: -40, y: -10 }, { x: 20, y: 26 })
    expect(outlineContains('visual.diamond', box, pulled)).toBe(true)
    expect(pulled.x).toBeGreaterThan(20)
  })

  it('is total: a segment that never enters the outline returns the terminal unchanged', () => {
    const kept = outlineEntryPoint('visual.ellipse', box, { x: -40, y: 20 }, { x: 10, y: 20 })
    expect(kept).toEqual({ x: 10, y: 20 })
    expect(
      outlineEntryPoint(
        'visual.ellipse',
        { x: Number.NaN, y: 0, w: 1, h: 1 },
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ),
    ).toEqual({ x: 1, y: 1 })
  })
})

describe('degenerate boxes and unsupported shapes', () => {
  it('a zero-area polygon outline contains ONLY its collapsed vertex, like the ellipse rule', () => {
    const collapsed = { x: 5, y: 5, w: 0, h: 0 }
    expect(outlineContains('visual.diamond', collapsed, { x: 5, y: 5 })).toBe(true)
    expect(outlineContains('visual.diamond', collapsed, { x: 6, y: 5 })).toBe(false)
    expect(outlineContains('visual.hexagon', collapsed, { x: 40, y: -3 })).toBe(false)
  })

  it('an unsupported runtime shape value degrades to null / false, never a throw', () => {
    const bogus = 'blob' as unknown as Parameters<typeof nodeOutline>[0]
    expect(nodeOutline(bogus, box)).toBeNull()
    expect(outlineContains(bogus, box, { x: 60, y: 50 })).toBe(false)
    expect(outlineEntryPoint(bogus, box, { x: -40, y: 50 }, { x: 10, y: 50 })).toEqual({
      x: 10,
      y: 50,
    })
  })

  it('a one-axis-degenerate polygon contains only its own segment, not the infinite line', () => {
    // Collinear vertices zero every cross product, so without a bounds
    // check the loop accepts the whole line through the segment.
    const zeroWidth = { x: 5, y: 0, w: 0, h: 60 }
    expect(outlineContains('visual.diamond', zeroWidth, { x: 5, y: 45 })).toBe(true)
    expect(outlineContains('visual.diamond', zeroWidth, { x: 5, y: 1000 })).toBe(false)
    expect(outlineContains('visual.diamond', zeroWidth, { x: 5, y: -1 })).toBe(false)
    const zeroHeight = { x: 0, y: 5, w: 60, h: 0 }
    expect(outlineContains('visual.hexagon', zeroHeight, { x: 30, y: 5 })).toBe(true)
    expect(outlineContains('visual.hexagon', zeroHeight, { x: 1000, y: 5 })).toBe(false)
  })

  it('cylinder entry: an approach into the top-left cap region lands on the cap boundary', () => {
    // The cap is the one region where containment is not a single convex
    // quadratic — this pins that the bisection's convex-along-the-ray
    // assumption holds for the composite silhouette too.
    const pulled = outlineEntryPoint('visual.cylinder', box, { x: -40, y: 0 }, { x: 14, y: 22 })
    expect(outlineContains('visual.cylinder', box, pulled)).toBe(true)
    expect(outlineContains('visual.cylinder', box, { x: pulled.x - 1, y: pulled.y - 0.5 })).toBe(
      false,
    )
  })
})

describe('outlineContentBox — the inscribed box content must stay inside', () => {
  const kinds = [
    'visual.ellipse',
    'visual.diamond',
    'visual.hexagon',
    'visual.parallelogram',
    'visual.cylinder',
  ] as const

  it('every corner of the content box lies inside the outline, for every kind', () => {
    for (const kind of kinds) {
      const content = outlineContentBox(kind, box)
      const corners = [
        { x: content.x, y: content.y },
        { x: content.x + content.w, y: content.y },
        { x: content.x + content.w, y: content.y + content.h },
        { x: content.x, y: content.y + content.h },
      ]
      for (const corner of corners) {
        expect(outlineContains(kind, box, corner), `${kind} corner ${JSON.stringify(corner)}`).toBe(
          true,
        )
      }
    }
  })

  it('strictly narrows the box for every kind — a shaped node never keeps the full rect', () => {
    for (const kind of kinds) {
      const content = outlineContentBox(kind, box)
      expect(content.w * content.h, kind).toBeLessThan(box.w * box.h)
      expect(content.w, kind).toBeGreaterThan(0)
      expect(content.h, kind).toBeGreaterThan(0)
    }
  })

  it('no outline (a plain rect) answers the box unchanged', () => {
    expect(outlineContentBox(undefined, box)).toEqual(box)
  })

  it('is total: an unsupported runtime value degrades to the box, never a throw', () => {
    const bogus = 'blob' as unknown as Parameters<typeof nodeOutline>[0]
    expect(outlineContentBox(bogus, box)).toEqual(box)
  })
})
