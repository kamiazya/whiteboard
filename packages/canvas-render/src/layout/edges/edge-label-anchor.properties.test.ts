// The obstacle pre-filter in `edgeLabelPlacement` may only PRUNE: on any
// board, the spot it picks must equal the one the unfiltered search picks,
// every candidate checked against every obstacle. The oracle is that search
// as it stood, copied whole; it shares only `flattenRoundedEdgePath`, which
// decides the line and not what blocks the label.

import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import type { Point } from './edge-geometry.js'
import { edgeLabelPlacement, type LabelObstacle, type LabelSize } from './edge-label-anchor.js'
import { flattenRoundedEdgePath } from './edge-rounding.js'

function oracleMidpoint(path: readonly Point[], rounded?: boolean) {
  const first = path[0]
  if (path.length < 2 || first === undefined) return undefined
  if (path.every((p) => p.x === first.x && p.y === first.y)) return undefined
  const drawn = rounded === true ? flattenRoundedEdgePath(path) : path
  const lengths: number[] = []
  let total = 0
  for (let i = 0; i + 1 < drawn.length; i++) {
    const length = Math.hypot(drawn[i + 1]!.x - drawn[i]!.x, drawn[i + 1]!.y - drawn[i]!.y)
    lengths.push(length)
    total += length
  }
  let remaining = total / 2
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i]!) {
      const t = lengths[i] === 0 ? 0 : remaining / lengths[i]!
      const from = drawn[i]!
      const to = drawn[i + 1]!
      return {
        point: { x: from.x + t * (to.x - from.x), y: from.y + t * (to.y - from.y) },
        from,
        to,
      }
    }
    remaining -= lengths[i]!
  }
  const last = drawn[drawn.length - 1]!
  return { point: last, from: drawn[drawn.length - 2]!, to: last }
}

const overlaps = (a: LabelObstacle, b: LabelObstacle): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** The unfiltered search: every candidate against every obstacle. */
function oracle(
  path: readonly Point[],
  size: LabelSize,
  obstacles: readonly LabelObstacle[],
  rounded: boolean,
): { at: Point | undefined; blocked: boolean } {
  const mid = oracleMidpoint(path, rounded)
  if (mid === undefined) return { at: undefined, blocked: false }
  const boxAt = (c: Point): LabelObstacle => ({
    x: c.x - size.w / 2,
    y: c.y - size.h / 2,
    w: size.w,
    h: size.h,
  })
  const clear = (c: Point) => !obstacles.some((o) => overlaps(boxAt(c), o))
  if (clear(mid.point)) return { at: mid.point, blocked: false }
  const length = Math.hypot(mid.to.x - mid.from.x, mid.to.y - mid.from.y)
  if (length === 0) return { at: mid.point, blocked: true }
  const dir = { x: (mid.to.x - mid.from.x) / length, y: (mid.to.y - mid.from.y) / length }
  const normals = [
    { x: -dir.y, y: dir.x },
    { x: dir.y, y: -dir.x },
  ].sort((a, b) => a.y - b.y || a.x - b.x)
  for (let d = 8; d <= 128; d += 8) {
    for (const n of normals) {
      const candidate = { x: mid.point.x + n.x * d, y: mid.point.y + n.y * d }
      if (clear(candidate)) return { at: candidate, blocked: true }
    }
  }
  return { at: mid.point, blocked: true }
}

// The path in the middle of the board and obstacles all around it, out past
// the search's 128px reach, so boxes land just inside and just outside the
// window the filter keeps; fractional and diagonal, so a candidate's offset
// rounds.
const coordinate = (min: number, max: number) =>
  fc.noBias(fc.oneof(fc.integer({ min, max }), fc.double({ min, max, noNaN: true })))
const pointArb = fc.record({ x: coordinate(150, 450), y: coordinate(150, 450) })
const obstacleArb = fc.record({
  x: coordinate(-50, 600),
  y: coordinate(-50, 600),
  w: coordinate(4, 160),
  h: coordinate(4, 160),
})
const sizeArb = fc.record({ w: coordinate(8, 140), h: coordinate(8, 40) })
const caseArb = fc.record({
  path: fc.array(pointArb, { minLength: 2, maxLength: 5 }),
  size: sizeArb,
  obstacles: fc.array(obstacleArb, { minLength: 20, maxLength: 60 }),
  rounded: fc.boolean(),
})

// A straight edge through a fixed centre, a blocker around its midpoint
// big enough to push the label to the far end of its slide, and small
// boxes scattered on the rim of the search: whether the last candidates
// are clear is decided by exactly the boxes nearest the window's edge.
const CENTRE = 300
const rimArb = fc.record({
  dx: coordinate(-220, 220),
  dy: coordinate(-220, 220),
  w: coordinate(2, 40),
  h: coordinate(2, 40),
})
const rimCaseArb = fc
  .record({
    angle: fc.oneof(
      fc.constantFrom(0, Math.PI / 2),
      fc.double({ min: 0, max: Math.PI, noNaN: true }),
    ),
    half: coordinate(10, 150),
    blocker: fc.record({ x: coordinate(60, 140), y: coordinate(60, 140) }),
    rim: fc.array(rimArb, { minLength: 4, maxLength: 24 }),
    size: sizeArb,
    rounded: fc.boolean(),
  })
  .map(({ angle, half, blocker, rim, size, rounded }) => ({
    path: [
      { x: CENTRE - half * Math.cos(angle), y: CENTRE - half * Math.sin(angle) },
      { x: CENTRE + half * Math.cos(angle), y: CENTRE + half * Math.sin(angle) },
    ],
    obstacles: [
      ...rim.map((r) => ({ x: CENTRE + r.dx, y: CENTRE + r.dy, w: r.w, h: r.h })),
      { x: CENTRE - blocker.x, y: CENTRE - blocker.y, w: 2 * blocker.x, h: 2 * blocker.y },
    ],
    size,
    rounded,
  }))

/** Where the slide gives out: the last two offsets of the 128px reach. */
const FAR_SLIDE_PX = 120

const reach = { cases: 0, blocked: 0, slid: 0, far: 0 }

describe('edgeLabelPlacement obstacle pre-filter', () => {
  fcTest.prop([fc.oneof(caseArb, rimCaseArb)], withDefaults({ numRuns: 1000 }))(
    'places a label exactly where the unfiltered search does',
    ({ path, size, obstacles, rounded }) => {
      reach.cases++
      const expected = oracle(path, size, obstacles, rounded)
      if (expected.blocked) reach.blocked++
      const mid = oracleMidpoint(path, rounded)?.point
      if (expected.at !== undefined && mid !== undefined) {
        const offset = Math.hypot(expected.at.x - mid.x, expected.at.y - mid.y)
        if (offset > 0) reach.slid++
        if (offset >= FAR_SLIDE_PX - 1e-6) reach.far++
      }
      expect(edgeLabelPlacement(path, size, obstacles, rounded)).toEqual(expected.at)
    },
  )

  afterAllFloor(['places a label exactly where the unfiltered search does'], () => {
    // The midpoint is blocked often enough that the slide, and the filter
    // it searches through, decide the answer — not only the first check.
    // And often enough that the answer sits at the far end of the reach,
    // where only the boxes on the window's edge decide it.
    // Measured 0.62 blocked, 0.44 slid, 0.11 far.
    expect(reach.blocked / reach.cases).toBeGreaterThan(0.3)
    expect(reach.slid / reach.cases).toBeGreaterThan(0.2)
    expect(reach.far / reach.cases).toBeGreaterThan(0.05)
  })
})
