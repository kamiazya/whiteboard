// The sketch ink decomposition is a pure function of semantic geometry and a
// seed (decision #10, ADR-0030 decision 7): what it paints may leave the
// bbox by at most a DECLARED constant, the same input draws the same ink
// twice, and moving the geometry moves the ink with it — no positional
// input reaches the randomness.
import { test } from '@fast-check/vitest'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { BoundingBox } from '../../scene-graph.js'
import { BUILT_IN_SHAPES, nodeOutline } from '../nodes/node-outline.js'
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
const shapeId = fc.constantFrom(undefined, ...Object.keys(BUILT_IN_SHAPES))

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
