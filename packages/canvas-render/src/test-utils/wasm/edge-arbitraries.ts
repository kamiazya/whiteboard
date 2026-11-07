import type { Point, Rect } from '../../layout/edges/edge-geometry.js'
import { fc } from '../fast-check.js'

/**
 * What the edge layer's Rust differentials share (ADR-0054 step 5, QR-21
 * layer 2): the exact comparison every one of them makes, and the draws
 * they make it on.
 */

/** Equal as doubles, NaN equal to NaN (a payload does not survive a typed array), a signed zero counted. */
export const sameDouble = (a: number, b: number) =>
  Number.isNaN(a) || Number.isNaN(b) ? Number.isNaN(a) && Number.isNaN(b) : Object.is(a, b)

/** The first index the two answers differ at, for a minimal repro. */
export function firstDifference(ts: readonly number[], rust: Float64Array): string | undefined {
  const at = ts.findIndex((v, i) => !sameDouble(v, rust[i] ?? Number.NaN))
  if (at === -1 && ts.length === rust.length) return undefined
  const i = at === -1 ? Math.min(ts.length, rust.length) : at
  const show = (v: number | undefined) => (Object.is(v, -0) ? '-0' : String(v))
  return `index ${i}: ts ${show(ts[i])}, rust ${show(rust[i])} (lengths ${ts.length}, ${rust.length})`
}

/**
 * Coordinates mostly on a 2.5px lattice, so paths run along each other and
 * along borders (where the ink terms are non-zero), sometimes on an
 * eighth-pixel one, which lands on the half quanta `quantize` rounds, plus
 * the doubles JavaScript treats specially.
 */
export const coordinate = fc.oneof(
  { weight: 10, arbitrary: fc.integer({ min: -40, max: 80 }).map((k) => k * 2.5) },
  { weight: 2, arbitrary: fc.integer({ min: -400, max: 800 }).map((k) => k / 8) },
  { weight: 1, arbitrary: fc.double({ min: -200, max: 200 }) },
  { weight: 1, arbitrary: fc.constantFrom(-0, Number.NaN, Number.POSITIVE_INFINITY, -1e300) },
)
export const size = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: 1, max: 24 }).map((k) => k * 2.5) },
  { weight: 1, arbitrary: fc.constantFrom(0, -0, -10, Number.NaN) },
)
export const point = fc.record({ x: coordinate, y: coordinate })
export const rect = fc.record({ x: coordinate, y: coordinate, w: size, h: size })

/** A path that mostly turns at right angles, as a routed edge does, sometimes cutting a diagonal. */
export const path = fc
  .tuple(
    point,
    fc.array(
      fc.tuple(fc.constantFrom('h', 'v', 'h', 'v', 'diagonal', 'repeat'), coordinate, coordinate),
      { maxLength: 7 },
    ),
  )
  .map(([start, steps]) => {
    const points: Point[] = [start]
    for (const [kind, a, b] of steps) {
      const last = points.at(-1) as Point
      if (kind === 'h') points.push({ x: a, y: last.y })
      else if (kind === 'v') points.push({ x: last.x, y: a })
      else if (kind === 'repeat') points.push({ ...last })
      else points.push({ x: a, y: b })
    }
    return points
  })

/**
 * Rects drawn AGAINST a path as well as anywhere: a corner on one of its
 * points (so a segment runs along that rect's border), or centred on a
 * segment's midpoint (so the segment, diagonal or not, runs through it).
 * Placed anywhere, a rect almost never shares a line with a path, and the
 * border and diagonal terms would be compared on zeros.
 */
export function rectsAgainst(p: readonly Point[]): fc.Arbitrary<Rect[]> {
  const anchored = fc
    .tuple(fc.nat(p.length - 1), size, size, fc.constantFrom('corner', 'far-corner', 'midpoint'))
    .map(([i, w, h, kind]): Rect => {
      const a = p[i] as Point
      const b = p[Math.min(i + 1, p.length - 1)] as Point
      if (kind === 'corner') return { x: a.x, y: a.y, w, h }
      if (kind === 'far-corner') return { x: a.x - w, y: a.y - h, w, h }
      return { x: (a.x + b.x) / 2 - w / 2, y: (a.y + b.y) / 2 - h / 2, w, h }
    })
  return fc.array(fc.oneof(rect, anchored, anchored), { maxLength: 5 })
}

/** A path and rects drawn against it; see {@link rectsAgainst}. */
export const pathAndRects = path.chain((p) => fc.tuple(fc.constant(p), rectsAgainst(p)))
