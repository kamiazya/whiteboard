// The sketch ink decomposition is a pure function of semantic geometry and a
// seed (decision #10, ADR-0030 decision 7): what it paints may leave the
// bbox by at most a DECLARED constant, the same input draws the same ink
// twice, and moving the geometry moves the ink with it — no positional
// input reaches the randomness.
import { test } from '@fast-check/vitest'
import type { BoundingBox } from '@kamiazya/whiteboard-scene'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BUNDLED_SHAPE_TABLE, nodeOutline } from '../nodes/node-outline.js'
import { styleRandomFromSeed } from '../seed.js'
import { SKETCH_INK_REACH_PX, SKETCH_PASSES, sketchEdge, sketchShape } from './sketch.js'

/** Every number pair in a path's `d`: end AND control points, which bound a quadratic. */
function pointsOf(d: string): { x: number; y: number }[] {
  const numbers = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
  const points: { x: number; y: number }[] = []
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    points.push({ x: numbers[i]!, y: numbers[i + 1]! })
  }
  return points
}

const box = fc.record({
  x: fc.integer({ min: -500, max: 500 }),
  y: fc.integer({ min: -500, max: 500 }),
  w: fc.integer({ min: 20, max: 400 }),
  h: fc.integer({ min: 20, max: 300 }),
})
const seed = fc.integer({ min: 0, max: 0xffffffff })
const shapeId = fc.constantFrom(undefined, ...Object.keys(BUNDLED_SHAPE_TABLE))

const within = (p: { x: number; y: number }, b: BoundingBox, reach: number) =>
  p.x >= b.x - reach && p.x <= b.x + b.w + reach && p.y >= b.y - reach && p.y <= b.y + b.h + reach

describe('sketchShape', () => {
  test.prop([box, seed, shapeId])(
    'every stroke stays within the bbox plus the declared reach',
    (b, s, id) => {
      const outline = id === undefined ? null : nodeOutline(id, b)
      const ink = sketchShape(outline, b, s, { hatch: true })
      for (const d of [...ink.strokes, ...(ink.hatch ?? [])]) {
        for (const p of pointsOf(d)) expect(within(p, b, SKETCH_INK_REACH_PX)).toBe(true)
      }
    },
  )

  test.prop([box, seed, shapeId])(
    'the same geometry and seed draw the same ink twice',
    (b, s, id) => {
      const outline = id === undefined ? null : nodeOutline(id, b)
      expect(sketchShape(outline, b, s)).toEqual(sketchShape(outline, b, s))
    },
  )

  test.prop([box, seed, fc.integer({ min: -300, max: 300 }), fc.integer({ min: -300, max: 300 })])(
    'moving the box moves the ink with it — the randomness has no positional input',
    (b, s, dx, dy) => {
      const moved = { ...b, x: b.x + dx, y: b.y + dy }
      const here = sketchShape(null, b, s).strokes.flatMap(pointsOf)
      const there = sketchShape(null, moved, s).strokes.flatMap(pointsOf)
      expect(there.length).toBe(here.length)
      for (const [i, p] of here.entries()) {
        expect(there[i]!.x).toBeCloseTo(p.x + dx, 6)
        expect(there[i]!.y).toBeCloseTo(p.y + dy, 6)
      }
    },
  )

  it('draws two passes over a rect — the doubled line is what reads as hand-drawn', () => {
    const ink = sketchShape(null, { x: 0, y: 0, w: 100, h: 60 }, 7)
    expect(ink.strokes).toHaveLength(2)
    expect(ink.hatch).toBeUndefined()
  })

  it('a different seed draws different ink', () => {
    const b = { x: 0, y: 0, w: 100, h: 60 }
    expect(sketchShape(null, b, 1)).not.toEqual(sketchShape(null, b, 2))
  })

  it('hatches a filled shape with lines that stay inside the silhouette', () => {
    const b = { x: 10, y: 10, w: 120, h: 80 }
    const ink = sketchShape(nodeOutline('visual.ellipse', b), b, 3, { hatch: true })
    expect(ink.hatch?.length ?? 0).toBeGreaterThan(4)
    const cx = b.x + b.w / 2
    const cy = b.y + b.h / 2
    for (const d of ink.hatch ?? []) {
      for (const p of pointsOf(d)) {
        // Inside the ellipse, with the jitter's slack.
        const norm = ((p.x - cx) / (b.w / 2)) ** 2 + ((p.y - cy) / (b.h / 2)) ** 2
        expect(norm).toBeLessThanOrEqual(1.15)
      }
    }
  })

  it('a cylinder inks its lid as well as its silhouette, still in two passes', () => {
    const b = { x: 0, y: 0, w: 100, h: 80 }
    const ink = sketchShape(nodeOutline('visual.cylinder', b), b, 5)
    expect(ink.strokes).toHaveLength(2)
    // The lid is the lower half of the top cap: a stroke dips below the cap
    // line at the centre, into the band between the cap line and 2·ry. The
    // band is what excludes the bottom cap, which also crosses the centre —
    // at the far end of the box — and would satisfy a one-sided test alone.
    const outline = nodeOutline('visual.cylinder', b)
    const ry = outline?.kind === 'cylinder' ? outline.ry : 0
    const capLine = b.y + ry
    const lidDepth = pointsOf(ink.strokes[0]!).filter(
      (p) => p.x > 45 && p.x < 55 && p.y > capLine && p.y < capLine + 2 * ry,
    )
    expect(lidDepth.length).toBeGreaterThan(0)
  })

  it('degrades to nothing on a non-finite box rather than throwing', () => {
    expect(sketchShape(null, { x: Number.NaN, y: 0, w: 10, h: 10 }, 1)).toEqual({ strokes: [] })
  })
})

describe('sketchEdge', () => {
  const path = fc.array(
    fc.record({ x: fc.integer({ min: 0, max: 600 }), y: fc.integer({ min: 0, max: 400 }) }),
    { minLength: 2, maxLength: 5 },
  )

  test.prop([path, seed])(
    'every stroke stays within the path bounds plus the declared reach',
    (pts, s) => {
      const ink = sketchEdge(pts, s, { arrows: [] })
      const b = {
        x: Math.min(...pts.map((p) => p.x)),
        y: Math.min(...pts.map((p) => p.y)),
        w: Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)),
        h: Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)),
      }
      for (const d of ink.strokes) {
        for (const p of pointsOf(d)) expect(within(p, b, SKETCH_INK_REACH_PX)).toBe(true)
      }
    },
  )

  test.prop([path, seed])('the same path and seed draw the same ink twice', (pts, s) => {
    expect(sketchEdge(pts, s, { arrows: [] })).toEqual(sketchEdge(pts, s, { arrows: [] }))
  })

  it('inks an arrowhead as two wing strokes rather than a marker', () => {
    const pts = [
      { x: 0, y: 10 },
      { x: 100, y: 10 },
    ]
    const bare = sketchEdge(pts, 9, { arrows: [] })
    const arrowed = sketchEdge(pts, 9, {
      arrows: [
        {
          points: [
            { x: 100, y: 10 },
            { x: 90, y: 6 },
            { x: 90, y: 14 },
          ],
        },
      ],
    })
    expect(arrowed.strokes.length).toBe(bare.strokes.length + 2)
  })

  it('a jump hop survives into the ink — the pencil goes over the crossing, not through it', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ]
    const ink = sketchEdge(pts, 5, { arrows: [], jumps: [{ segment: 0, x: 100, y: 0 }] })
    // The hop bulges to the left of travel — upward, for a rightward run —
    // by the jump radius, and a stroke that resampled every 24px kept none
    // of its points, so the line crossed flat.
    const highest = Math.min(...ink.strokes.flatMap(pointsOf).map((p) => p.y))
    expect(highest).toBeLessThan(-3)
  })

  it('a bend closer than the anchor step to its neighbour is still turned, not cut diagonally', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 100 },
    ]
    const ink = sketchEdge(pts, 6, { arrows: [] })
    const nearCorner = ink.strokes.flatMap(pointsOf).some((p) => Math.hypot(p.x - 20, p.y - 0) < 3)
    expect(nearCorner).toBe(true)
  })

  it('a rounded path is inked along the rounded corners it is drawn with', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ]
    const square = sketchEdge(pts, 4, { arrows: [] })
    const rounded = sketchEdge(pts, 4, { arrows: [], rounded: true })
    expect(rounded).not.toEqual(square)
    // No rounded stroke passes through the square corner itself.
    for (const p of rounded.strokes.flatMap(pointsOf)) {
      expect(Math.hypot(p.x - 100, p.y - 0)).toBeGreaterThan(3)
    }
  })
})

describe('what reads as a hand rather than a tremor', () => {
  const rect = (w: number, h: number): BoundingBox => ({ x: 0, y: 0, w, h })
  /** How far each quadratic's control point sits off its own chord. */
  function bowsOf(d: string): number[] {
    const out: number[] = []
    const re = /M (-?[\d.]+) (-?[\d.]+)|Q (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/g
    let from: { x: number; y: number } | undefined
    for (const m of d.matchAll(re)) {
      if (m[1] !== undefined) {
        from = { x: Number(m[1]), y: Number(m[2]) }
        continue
      }
      const c = { x: Number(m[3]), y: Number(m[4]) }
      const to = { x: Number(m[5]), y: Number(m[6]) }
      if (from === undefined) continue
      const dx = to.x - from.x
      const dy = to.y - from.y
      const len = Math.hypot(dx, dy)
      out.push(len === 0 ? 0 : Math.abs((c.x - from.x) * dy - (c.y - from.y) * dx) / len)
      from = to
    }
    return out
  }

  it('a long side bows more than a short one — the amplitude follows the length, as a hand does', () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8]
    const mean = (w: number) =>
      seeds.reduce((sum, s) => {
        const bows = bowsOf(sketchShape(null, rect(w, w), s).strokes[0]!)
        return sum + Math.max(...bows)
      }, 0) / seeds.length
    expect(mean(600)).toBeGreaterThan(mean(60) * 2)
  })

  it('a closed outline is one continuous sub-path per pass, so its corners meet', () => {
    const ink = sketchShape(null, rect(120, 80), 9)
    expect(ink.strokes).toHaveLength(SKETCH_PASSES)
    for (const d of ink.strokes) expect(d.match(/M /g)).toHaveLength(1)
    const ellipse = sketchShape(nodeOutline('visual.ellipse', rect(120, 80)), rect(120, 80), 9)
    for (const d of ellipse.strokes) expect(d.match(/M /g)).toHaveLength(1)
  })

  it("the hatch angle and gap are the node's own, drawn near a base rather than ruled identically on every box", () => {
    const b = rect(200, 120)
    const angleOf = (d: string): number => {
      const [from, , to] = pointsOf(d)
      return (Math.atan2(to!.y - from!.y, to!.x - from!.x) * 180) / Math.PI
    }
    const angles = Array.from({ length: 20 }, (_, i) => {
      const ink = sketchShape(null, b, i + 1, { hatch: true })
      return angleOf(ink.hatch![Math.floor(ink.hatch!.length / 2)]!)
    })
    // Every hand hatches at roughly the same slant, but no two boxes at exactly the same one.
    for (const a of angles) expect(Math.abs(a - -41)).toBeLessThan(14)
    expect(new Set(angles.map((a) => Math.round(a))).size).toBeGreaterThan(3)
    const gaps = Array.from(
      { length: 6 },
      (_, i) => sketchShape(null, b, i + 1, { hatch: true }).hatch!.length,
    )
    expect(new Set(gaps).size).toBeGreaterThan(1)
  })

  it('a straight-sided outline closes PAST its start — the overshoot a pen leaves at the last corner', () => {
    const b = rect(120, 80)
    for (const s of [1, 2, 3]) {
      for (const d of sketchShape(null, b, s).strokes) {
        const pts = pointsOf(d)
        const first = pts[0]!
        const last = pts[pts.length - 1]!
        // The last side runs up the left edge toward the top-left corner, so
        // overshooting it means ending ABOVE the start, not merely near it.
        expect(first.y - last.y).toBeGreaterThan(1)
        expect(Math.abs(last.x - first.x)).toBeLessThan(SKETCH_INK_REACH_PX)
      }
    }
  })
})

// The ink's arithmetic, pinned by replaying the seeded stream. Everything above
// states what ink must satisfy (reach, determinism, translation); none of it
// notices a jitter drawn on the wrong side of zero, a bow along the chord
// instead of across it, or a vertex shaken by the wrong share — each moves a
// stroke by well under the declared reach. The oracle below owns only the
// stream (`styleRandomFromSeed`, judged by `seed.test.ts`) and restates what
// the module's header promises: each end is displaced by up to ±jitter per
// axis, a side's control point sits `t` of the way along its chord and `off`
// across it, and a closed outline overshoots its start by `OVERSHOOT_PX`.
describe('the ink arithmetic, replayed from the seeded stream', () => {
  type Pt = { x: number; y: number }
  const signed = (u: number): number => u * 2 - 1

  /** The control point of a bowed quadratic over a→b, drawing `t` then `off`. */
  function bowedControl(rng: () => number, a: Pt, b: Pt, bow: number): Pt {
    const t = 0.35 + rng() * 0.3
    const off = signed(rng()) * bow
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    // A zero-length chord has no normal, so it sits on the chord's own point.
    const across = len === 0 ? { x: 0, y: 0 } : { x: -(b.y - a.y) / len, y: (b.x - a.x) / len }
    return {
      x: a.x + (b.x - a.x) * t + across.x * off,
      y: a.y + (b.y - a.y) * t + across.y * off,
    }
  }

  /** The numbers of a path's `d`, with `NaN` kept (a NaN must fail a comparison, not vanish). */
  function numbersOf(d: string): number[] {
    return d
      .split(' ')
      .filter((token) => token !== 'M' && token !== 'Q')
      .map(Number)
  }

  /** Two-decimal rounding is the only slack: every other difference is a different draw or sum. */
  function expectNumbers(actual: number[], expected: number[]): void {
    expect(actual).toHaveLength(expected.length)
    for (const [i, value] of expected.entries()) {
      expect(Math.abs(actual[i]! - value)).toBeLessThanOrEqual(0.00501)
    }
  }

  /**
   * One displaced copy of each vertex: up to ±`amount` per axis, scaled by the
   * nearer neighbour's spacing over 12px. A vertex with no neighbour (the end
   * of an open run, or the only vertex) is shaken in full.
   */
  function shakenVertices(rng: () => number, pts: readonly Pt[], amount: number, closed: boolean) {
    const n = pts.length
    const gap = (i: number, j: number): number =>
      Math.hypot(pts[j]!.x - pts[i]!.x, pts[j]!.y - pts[i]!.y)
    return pts.map((p, i) => {
      const before =
        i > 0 ? gap(i - 1, i) : closed && n > 1 ? gap(n - 1, i) : Number.POSITIVE_INFINITY
      const after =
        i < n - 1 ? gap(i, i + 1) : closed && n > 1 ? gap(i, 0) : Number.POSITIVE_INFINITY
      const share = Math.min(1, Math.min(before, after) / 12)
      return {
        x: p.x + signed(rng()) * amount * share,
        y: p.y + signed(rng()) * amount * share,
      }
    })
  }

  /** `strokePolyline`'s vertices shaken by up to ±1.2, then a bowed side per edge. */
  function polylineNumbers(rng: () => number, pts: readonly Pt[], closed: boolean): number[] {
    const n = pts.length
    const length = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y)
    const shook = shakenVertices(rng, pts, 1.2, closed)
    const out = [shook[0]!.x, shook[0]!.y]
    const sides = closed ? n : n - 1
    for (let i = 0; i < sides; i += 1) {
      const a = pts[i]!
      const b = pts[(i + 1) % n]!
      const len = length(a, b)
      const control = bowedControl(rng, a, b, Math.min(6, len * 0.012))
      let to = shook[(i + 1) % n]!
      // A closing side with no direction has nothing to run past the start along.
      if (closed && i === sides - 1 && len > 0) {
        to = { x: to.x + ((b.x - a.x) / len) * 3, y: to.y + ((b.y - a.y) / len) * 3 }
      }
      out.push(control.x, control.y, to.x, to.y)
    }
    return out
  }

  /** `strokeCurve`'s vertices shaken by up to ±0.7, then a chord through each true midpoint. */
  function curveNumbers(
    rng: () => number,
    pts: readonly Pt[],
    mids: readonly Pt[],
    closed: boolean,
  ): number[] {
    const n = pts.length
    const shook = shakenVertices(rng, pts, 0.7, closed)
    const out = [shook[0]!.x, shook[0]!.y]
    for (let i = 0; i < (closed ? n : n - 1); i += 1) {
      const a = pts[i]!
      const b = pts[(i + 1) % n]!
      const mid = mids[i]!
      // The quadratic through the arc's midpoint has its control point at 2·mid − (a+b)/2.
      out.push(
        2 * mid.x - (a.x + b.x) / 2 + signed(rng()) * 0.8,
        2 * mid.y - (a.y + b.y) / 2 + signed(rng()) * 0.8,
        shook[(i + 1) % n]!.x,
        shook[(i + 1) % n]!.y,
      )
    }
    return out
  }

  const rectBox = fc.record({
    w: fc.integer({ min: 4, max: 900 }),
    h: fc.integer({ min: 4, max: 900 }),
  })

  test.prop([rectBox, seed])(
    'a rect is two passes of shaken corners joined by bowed sides, closing past its start',
    ({ w, h }, s) => {
      const corners = [
        { x: 0, y: 0 },
        { x: w, y: 0 },
        { x: w, y: h },
        { x: 0, y: h },
      ]
      const rng = styleRandomFromSeed(s)
      const ink = sketchShape(null, { x: 0, y: 0, w, h }, s)
      for (const d of ink.strokes) expectNumbers(numbersOf(d), polylineNumbers(rng, corners, true))
    },
  )

  const bundledPolygons = Object.keys(BUNDLED_SHAPE_TABLE).filter(
    (id) => nodeOutline(id, { x: 0, y: 0, w: 100, h: 80 })?.kind === 'polygon',
  )

  it('the bundled shape table has polygon silhouettes to pin', () => {
    expect(bundledPolygons.length).toBeGreaterThan(2)
  })

  test.prop([fc.constantFrom(...bundledPolygons), box, seed])(
    'a polygon is inked as a closed polyline over its own vertices, past the start along its last side',
    (id, b, s) => {
      const outline = nodeOutline(id, b)
      if (outline?.kind !== 'polygon') throw new Error(`${id} is not a polygon`)
      const rng = styleRandomFromSeed(s)
      for (const d of sketchShape(outline, b, s).strokes) {
        expectNumbers(numbersOf(d), polylineNumbers(rng, outline.points, true))
      }
    },
  )

  // Outlines are convex with at least three vertices by contract, but the ink
  // is total over whatever a contribution hands it: a repeated closing vertex
  // has no direction to overshoot along, and a lone vertex has no neighbour.
  it.each([
    [
      'a closing side of zero length',
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 30 },
        { x: 0, y: 0 },
      ],
    ],
    ['a lone vertex', [{ x: 10, y: 10 }]],
    [
      'two vertices',
      [
        { x: 10, y: 10 },
        { x: 50, y: 40 },
      ],
    ],
  ])('a polygon of %s is inked without a non-finite number', (_label, points) => {
    const b = { x: 0, y: 0, w: 60, h: 50 }
    const rng = styleRandomFromSeed(11)
    for (const d of sketchShape({ kind: 'polygon', points }, b, 11).strokes) {
      const numbers = numbersOf(d)
      expect(numbers.every(Number.isFinite)).toBe(true)
      expectNumbers(numbers, polylineNumbers(rng, points, true))
    }
  })

  test.prop([box, seed])(
    'a cylinder is over the top cap, down the right, under the bottom cap, up the left, then the lid',
    (b, s) => {
      const outline = nodeOutline('visual.cylinder', b)
      if (outline?.kind !== 'cylinder') throw new Error('visual.cylinder is not a cylinder')
      const { x, y, w, h, ry } = outline
      const rx = w / 2
      const cx = x + rx
      const top = y + ry
      const bottom = y + h - ry
      /** A half-ellipse from `from` to `to`, 12 chords, ends included. */
      const arc = (cy: number, from: number, to: number) => {
        const step = (to - from) / 12
        const at = (angle: number): Pt => ({
          x: cx + rx * Math.cos(angle),
          y: cy + ry * Math.sin(angle),
        })
        return {
          pts: Array.from({ length: 13 }, (_, i) => at(from + step * i)),
          mids: Array.from({ length: 12 }, (_, i) => at(from + step * (i + 0.5))),
        }
      }
      const over = arc(top, Math.PI, 2 * Math.PI)
      const under = arc(bottom, 0, Math.PI)
      const lid = arc(top, Math.PI, 0)
      const right = [
        { x: x + w, y: top },
        { x: x + w, y: bottom },
      ]
      const left = [
        { x, y: bottom },
        { x, y: top },
      ]
      const rng = styleRandomFromSeed(s)
      for (const d of sketchShape(outline, b, s).strokes) {
        expectNumbers(numbersOf(d), [
          ...curveNumbers(rng, over.pts, over.mids, false),
          ...polylineNumbers(rng, right, false),
          ...curveNumbers(rng, under.pts, under.mids, false),
          ...polylineNumbers(rng, left, false),
          ...curveNumbers(rng, lid.pts, lid.mids, false),
        ])
      }
    },
  )

  it("a cylinder's hatch fills the region its two caps bound, so it has lines to draw", () => {
    const b = { x: 0, y: 0, w: 100, h: 80 }
    const ink = sketchShape(nodeOutline('visual.cylinder', b), b, 5, { hatch: true })
    expect(ink.hatch?.length ?? 0).toBeGreaterThan(4)
  })

  it('a polygon with no vertices inks as empty paths rather than throwing', () => {
    const ink = sketchShape({ kind: 'polygon', points: [] }, { x: 0, y: 0, w: 60, h: 50 }, 11)
    expect(ink.strokes).toEqual(['', ''])
  })

  it('a cylinder is five sub-paths per pass, its two straight sides left open', () => {
    const b = { x: 0, y: 0, w: 100, h: 80 }
    for (const d of sketchShape(nodeOutline('visual.cylinder', b), b, 5).strokes) {
      // Over the top cap, right side, under the bottom cap, left side, lid:
      // each starts at its own move and is separated from the last by a space.
      expect(d.match(/(?:^| )M /g)).toHaveLength(5)
      // 12 chords per cap arc and one side per straight run; a side closed
      // back on itself would draw a second one.
      expect(d.match(/Q /g)).toHaveLength(12 + 1 + 12 + 1 + 12)
    }
  })

  test.prop([box, seed])(
    'an ellipse is inked as 24 shaken chords, each bowed through its true midpoint',
    (b, s) => {
      const outline = nodeOutline('visual.ellipse', b)
      if (outline?.kind !== 'ellipse') throw new Error('visual.ellipse is not an ellipse')
      const at = (angle: number): Pt => ({
        x: outline.cx + outline.rx * Math.cos(angle),
        y: outline.cy + outline.ry * Math.sin(angle),
      })
      const step = (Math.PI * 2) / 24
      const pts = Array.from({ length: 24 }, (_, i) => at(i * step))
      const mids = Array.from({ length: 24 }, (_, i) => at((i + 0.5) * step))
      const rng = styleRandomFromSeed(s)
      for (const d of sketchShape(outline, b, s).strokes) {
        expectNumbers(numbersOf(d), curveNumbers(rng, pts, mids, true))
      }
    },
  )

  // Under 48px a straight run takes no anchor between its ends, so the path is
  // exactly its two points; the span reaches below the 12px at which a vertex
  // is shaken in proportion to its spacing.
  const shortRun = fc.record({
    x: fc.integer({ min: -200, max: 200 }),
    y: fc.integer({ min: -200, max: 200 }),
    dx: fc.integer({ min: -47, max: 47 }),
    dy: fc.integer({ min: -47, max: 47 }),
  })

  test.prop([shortRun, seed])(
    'a short edge is two passes over two shaken ends, a vertex shaken less the closer its neighbour',
    ({ x, y, dx, dy }, s) => {
      fc.pre(Math.hypot(dx, dy) >= 1 && Math.hypot(dx, dy) < 48)
      const pts = [
        { x, y },
        { x: x + dx, y: y + dy },
      ]
      const rng = styleRandomFromSeed(s)
      for (const d of sketchEdge(pts, s, { arrows: [] }).strokes) {
        expectNumbers(numbersOf(d), polylineNumbers(rng, pts, false))
      }
    },
  )

  // An arrowhead's wings are drawn by `jittered`: four displaced ends, then a
  // bowed quadratic over the undisplaced chord, ±1.2 on the ends and ±0.6 on
  // the bow. A wing as short as a pixel and one of zero length (no normal) are
  // both drawn, so the zero-length guards are reached.
  const wing = fc.oneof(
    { weight: 1, arbitrary: fc.constant({ dx: 0, dy: 0 }) },
    {
      weight: 4,
      arbitrary: fc.record({
        dx: fc.integer({ min: -60, max: 60 }),
        dy: fc.integer({ min: -60, max: 60 }),
      }),
    },
  )

  test.prop([wing, wing, seed])(
    'an arrowhead wing is a jittered quadratic over its chord, whatever its length',
    (left, right, s) => {
      const tip = { x: 100, y: 10 }
      const run = [
        { x: 60, y: 10 },
        { x: 100, y: 10 },
      ]
      const wingEnd = (w: { dx: number; dy: number }): Pt => ({ x: tip.x + w.dx, y: tip.y + w.dy })
      const ink = sketchEdge(run, s, {
        arrows: [{ points: [tip, wingEnd(left), wingEnd(right)] }],
      })
      // Two passes over the run first, each its own draws.
      const rng = styleRandomFromSeed(s)
      for (let pass = 0; pass < SKETCH_PASSES; pass += 1) polylineNumbers(rng, run, false)
      for (const [i, w] of [left, right].entries()) {
        const end = wingEnd(w)
        const ax = tip.x + signed(rng()) * 1.2
        const ay = tip.y + signed(rng()) * 1.2
        const bx = end.x + signed(rng()) * 1.2
        const by = end.y + signed(rng()) * 1.2
        const control = bowedControl(rng, tip, end, 0.6)
        expectNumbers(numbersOf(ink.strokes[SKETCH_PASSES + i]!), [
          ax,
          ay,
          control.x,
          control.y,
          bx,
          by,
        ])
      }
    },
  )

  it('a wing of zero length is drawn on its own point, with no normal to bow along', () => {
    const tip = { x: 50, y: 50 }
    const ink = sketchEdge(
      [
        { x: 10, y: 50 },
        { x: 50, y: 50 },
      ],
      3,
      { arrows: [{ points: [tip, tip, { x: 40, y: 44 }] }] },
    )
    expect(ink.strokes[SKETCH_PASSES]).not.toMatch(/NaN/)
  })
})
