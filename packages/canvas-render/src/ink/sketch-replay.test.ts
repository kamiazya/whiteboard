// The sketch ink's arithmetic, replayed from the seeded stream: split from
// sketch.test.ts, which states what ink must satisfy, while this file restates
// the numbers each stroke is built from.
import { test } from '@fast-check/vitest'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BUNDLED_SHAPE_TABLE, nodeOutline } from '../outline/node-outline.js'
import { styleRandomFromSeed } from './seed.js'
import { SKETCH_PASSES, sketchEdge, sketchShape } from './sketch.js'

const box = fc.record({
  x: fc.integer({ min: -500, max: 500 }),
  y: fc.integer({ min: -500, max: 500 }),
  w: fc.integer({ min: 20, max: 400 }),
  h: fc.integer({ min: 20, max: 300 }),
})
const seed = fc.integer({ min: 0, max: 0xffffffff })

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

  // A straight run re-anchors every 24px, evenly: `floor(length / 24)` sides,
  // so a long edge wobbles along its whole length instead of bowing once
  // between its two ends.
  const longRun = fc.record({
    x: fc.integer({ min: -200, max: 200 }),
    y: fc.integer({ min: -200, max: 200 }),
    dx: fc.integer({ min: -400, max: 400 }),
    dy: fc.integer({ min: -400, max: 400 }),
  })

  test.prop([longRun, seed])(
    'a long straight edge is re-anchored at even steps of at most 24px',
    ({ x, y, dx, dy }, s) => {
      const length = Math.hypot(dx, dy)
      fc.pre(length >= 48)
      const pieces = Math.floor(length / 24)
      const anchors = Array.from({ length: pieces + 1 }, (_, k) => ({
        x: x + (dx * k) / pieces,
        y: y + (dy * k) / pieces,
      }))
      const rng = styleRandomFromSeed(s)
      const ends = [anchors[0]!, anchors[pieces]!]
      for (const d of sketchEdge(ends, s, { arrows: [] }).strokes) {
        expectNumbers(numbersOf(d), polylineNumbers(rng, anchors, false))
      }
    },
  )

  // The hatch, replayed: one slant (-41° ± 10°) and one pitch (6px ± 25%) per
  // box, a ruling every pitch across the box's circumscribed circle, and each
  // ruling cut to where it crosses the silhouette — kept only when that chord
  // is a pixel or longer — then drawn as one jittered quadratic (±0.5 on the
  // ends, ±0.6 of bow). The cut is found here by intersecting the ruling with
  // each SIDE of the polygon, not by the half-plane clip the module runs, so
  // the two share no geometry; and nothing here reads the winding, so a
  // polygon listed clockwise must hatch exactly as the same one listed
  // counter-clockwise.
  /** Where the line `origin + s·dir` crosses the polygon's boundary: the [min, max] of `s`. */
  function chordOf(origin: Pt, dir: Pt, polygon: readonly Pt[]): readonly [number, number] | null {
    const hits: number[] = []
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[i]!
      const b = polygon[(i + 1) % polygon.length]!
      const ex = b.x - a.x
      const ey = b.y - a.y
      const det = dir.x * -ey - dir.y * -ex
      if (det === 0) continue
      // origin + s·dir = a + u·(b − a), by Cramer's rule.
      const rx = a.x - origin.x
      const ry = a.y - origin.y
      const along = (rx * -ey - ry * -ex) / det
      const u = (dir.x * ry - dir.y * rx) / det
      if (u >= -1e-9 && u <= 1 + 1e-9) hits.push(along)
    }
    if (hits.length < 2) return null
    return [Math.min(...hits), Math.max(...hits)]
  }

  const HATCH_REACHED = {
    clockwise: 'a clockwise polygon is hatched with at least one line',
    counterClockwise: 'a counter-clockwise polygon is hatched with at least one line',
    graze: 'a ruling crosses the silhouette by under a pixel and is dropped',
    repeated: 'a polygon with a repeated vertex is hatched with at least one line',
  } as const
  // Measured over seven default runs: each winding hatched in 40-60 of 100,
  // a repeated vertex in 62-75, a graze in 13-23. The floor sits under half
  // of the rarest.
  const HATCH_FLOOR = 5
  const hatchReached = new Map<keyof typeof HATCH_REACHED, number>()
  const noteHatch = (key: keyof typeof HATCH_REACHED, hit: boolean): void => {
    if (hit) hatchReached.set(key, (hatchReached.get(key) ?? 0) + 1)
  }
  const HATCH_TITLE =
    'a hatch rules the box at its own slant and pitch, cut to the silhouette in either winding'
  afterAllFloor([HATCH_TITLE], () => {
    expect(
      Object.fromEntries(
        Object.keys(HATCH_REACHED).map((key) => [
          key,
          (hatchReached.get(key as keyof typeof HATCH_REACHED) ?? 0) >= HATCH_FLOOR,
        ]),
      ),
    ).toEqual(Object.fromEntries(Object.keys(HATCH_REACHED).map((key) => [key, true])))
  })

  /**
   * A silhouette to hatch: the rect, a bundled polygon, or a convex polygon
   * inscribed in the box's ellipse — each listed in either direction, and
   * sometimes with one vertex listed twice: a side of no length has no
   * normal, and must cut nothing.
   */
  const silhouette = fc.record({
    form: fc.constantFrom('rect', 'bundled', 'inscribed'),
    bundledId: fc.constantFrom(...bundledPolygons),
    angles: fc.uniqueArray(fc.integer({ min: 0, max: 359 }), { minLength: 3, maxLength: 9 }),
    reversed: fc.boolean(),
    repeat: fc.option(fc.nat({ max: 8 }), { freq: 3 }),
  })

  test.prop([silhouette, box, seed])(HATCH_TITLE, (shape, b, s) => {
    let region: Pt[]
    if (shape.form === 'rect') {
      region = [
        { x: b.x, y: b.y },
        { x: b.x + b.w, y: b.y },
        { x: b.x + b.w, y: b.y + b.h },
        { x: b.x, y: b.y + b.h },
      ]
    } else if (shape.form === 'bundled') {
      const outline = nodeOutline(shape.bundledId, b)
      if (outline?.kind !== 'polygon') throw new Error(`${shape.bundledId} is not a polygon`)
      region = [...outline.points]
    } else {
      region = [...shape.angles]
        .sort((p, q) => p - q)
        .map((deg) => ({
          x: b.x + b.w / 2 + (b.w / 2) * Math.cos((deg * Math.PI) / 180),
          y: b.y + b.h / 2 + (b.h / 2) * Math.sin((deg * Math.PI) / 180),
        }))
    }
    if (shape.reversed) region.reverse()
    if (shape.repeat !== null) {
      const at = shape.repeat % region.length
      region.splice(at, 0, region[at]!)
    }
    // The rect is the null outline, whose corners the module lists itself.
    const outline =
      shape.form === 'rect' && !shape.reversed && shape.repeat === null
        ? null
        : { kind: 'polygon' as const, points: region }

    const ink = sketchShape(outline, b, s, { hatch: true })

    const rng = styleRandomFromSeed(s)
    for (let pass = 0; pass < SKETCH_PASSES; pass += 1) polylineNumbers(rng, region, true)
    const angle = (-41 * Math.PI) / 180 + signed(rng()) * ((10 * Math.PI) / 180)
    const gap = 6 * (1 + signed(rng()) * 0.25)
    const dir = { x: Math.cos(angle), y: Math.sin(angle) }
    const cx = b.x + b.w / 2
    const cy = b.y + b.h / 2
    const reach = Math.hypot(b.w, b.h) / 2
    const expected: number[][] = []
    let grazes = 0
    for (let offset = -reach; offset <= reach; offset += gap) {
      const origin = { x: cx - dir.y * offset, y: cy + dir.x * offset }
      const chord = chordOf(origin, dir, region)
      if (chord === null) continue
      const [enter, exit] = chord
      if (exit - enter < 1) {
        if (exit - enter > 0) grazes += 1
        continue
      }
      const from = { x: origin.x + dir.x * enter, y: origin.y + dir.y * enter }
      const to = { x: origin.x + dir.x * exit, y: origin.y + dir.y * exit }
      const ends = [from.x, from.y, to.x, to.y].map((v) => v + signed(rng()) * 0.5)
      const control = bowedControl(rng, from, to, 0.6)
      expected.push([ends[0]!, ends[1]!, control.x, control.y, ends[2]!, ends[3]!])
    }

    expect(ink.hatch).toHaveLength(expected.length)
    for (const [i, line] of expected.entries()) expectNumbers(numbersOf(ink.hatch![i]!), line)

    let area = 0
    for (let i = 0; i < region.length; i += 1) {
      const p = region[i]!
      const q = region[(i + 1) % region.length]!
      area += p.x * q.y - q.x * p.y
    }
    noteHatch('clockwise', area < 0 && expected.length > 0)
    noteHatch('counterClockwise', area > 0 && expected.length > 0)
    noteHatch('graze', grazes > 0)
    noteHatch('repeated', shape.repeat !== null && expected.length > 0)
  })

  it.each([
    ['no vertices', []],
    ['a lone vertex', [{ x: 10, y: 10 }]],
    [
      'two vertices',
      [
        { x: 10, y: 10 },
        { x: 50, y: 40 },
      ],
    ],
  ])('a polygon of %s has no area to hatch', (_label, points) => {
    const ink = sketchShape({ kind: 'polygon', points }, { x: 0, y: 0, w: 60, h: 50 }, 11, {
      hatch: true,
    })
    expect(ink.hatch).toEqual([])
  })

  it.each([
    ['no width', { x: 0, y: 0, w: 0, h: 40 }],
    ['no height', { x: 0, y: 0, w: 40, h: 0 }],
    ['a negative width', { x: 0, y: 0, w: -10, h: 40 }],
    ['a negative height', { x: 0, y: 0, w: 40, h: -10 }],
  ])('a box with %s draws no ink', (_label, b) => {
    expect(sketchShape(null, b, 3, { hatch: true })).toEqual({ strokes: [] })
  })

  it.each([
    ['a single point', [{ x: 10, y: 10 }]],
    [
      'a non-finite x',
      [
        { x: 0, y: 0 },
        { x: Number.NaN, y: 20 },
        { x: 80, y: 20 },
      ],
    ],
    [
      'a non-finite y',
      [
        { x: 0, y: 0 },
        { x: 40, y: Number.POSITIVE_INFINITY },
        { x: 80, y: 20 },
      ],
    ],
  ])('an edge path of %s draws no ink', (_label, pts) => {
    expect(sketchEdge(pts, 3, { arrows: [] })).toEqual({ strokes: [] })
  })

  it('an arrowhead short of its two wing corners is skipped rather than drawn', () => {
    const run = [
      { x: 0, y: 10 },
      { x: 100, y: 10 },
    ]
    const ink = sketchEdge(run, 3, {
      arrows: [
        {
          points: [
            { x: 100, y: 10 },
            { x: 90, y: 6 },
          ],
        },
      ],
    })
    expect(ink.strokes).toHaveLength(SKETCH_PASSES)
  })
})
