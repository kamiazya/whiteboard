// Where an edge comment's pin lands, stated against an oracle that shares no
// arithmetic with `commentAnchor`: the pin lies ON the routed path, and no
// point of that path — sampled densely along every segment, vertices
// included — is nearer the stored anchor than the pin is. Together those say
// "the nearest point of the polyline" without restating the projection.
import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { commentAnchor } from './comment-geometry.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

type Pt = { readonly x: number; readonly y: number }

const EMPTY: SpatialCanvas = { nodes: [], edges: [] }
const TOLERANCE = 1e-6
/** The oracle's sampling pitch along a segment, in px. */
const PITCH = 0.25

const coord = fc.integer({ min: -300, max: 300 })
const point: fc.Arbitrary<Pt> = fc.record({ x: coord, y: coord })

/**
 * A routed path of one to six vertices. One vertex in five repeats its
 * predecessor, so zero-length segments — and a path that is a single point —
 * are drawn often enough to be judged rather than once in a blue moon.
 */
const path: fc.Arbitrary<readonly Pt[]> = fc
  .array(fc.tuple(point, fc.integer({ min: 0, max: 4 })), { minLength: 1, maxLength: 6 })
  .map((draws) => {
    const out: Pt[] = []
    for (const [p, repeat] of draws) out.push(repeat === 0 && out.length > 0 ? out.at(-1)! : p)
    return out
  })

const query: fc.Arbitrary<Pt> = fc.record({
  x: fc.integer({ min: -400, max: 400 }),
  y: fc.integer({ min: -400, max: 400 }),
})

const distance = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

/** Every point the oracle tries: each vertex, and each segment every `PITCH` px. */
function samplesOf(vertices: readonly Pt[]): { readonly at: Pt; readonly segment: number }[] {
  const out = vertices.map((at, i) => ({ at, segment: Math.max(0, i - 1) }))
  for (let i = 0; i + 1 < vertices.length; i += 1) {
    const a = vertices[i]!
    const b = vertices[i + 1]!
    const steps = Math.ceil(distance(a, b) / PITCH)
    for (let k = 1; k < steps; k += 1) {
      const t = k / steps
      out.push({ at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, segment: i })
    }
  }
  return out
}

/** Whether `p` lies on the polyline: on one of its segments, or on a vertex. */
function onPolyline(p: Pt, vertices: readonly Pt[]): boolean {
  if (vertices.some((v) => distance(p, v) <= TOLERANCE)) return true
  for (let i = 0; i + 1 < vertices.length; i += 1) {
    const a = vertices[i]!
    const b = vertices[i + 1]!
    const len = distance(a, b)
    if (len === 0) continue
    const across = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len
    const along = ((b.x - a.x) * (p.x - a.x) + (b.y - a.y) * (p.y - a.y)) / len
    if (Math.abs(across) <= TOLERANCE && along >= -TOLERANCE && along <= len + TOLERANCE)
      return true
  }
  return false
}

const edgeComment = (at: Pt): CanvasComment => ({
  id: 'c',
  x: at.x,
  y: at.y,
  text: 'on the edge',
  targetEdgeId: 'e',
})

const REACHED = {
  single: 'the path is one distinct point, so every segment has zero length',
  interior: 'the pin lands strictly inside a segment, not on a vertex',
  clamped: 'the pin lands on a vertex of a path with a real segment',
  later: 'the nearest sample lies past the first segment',
} as const
// Measured over three default runs of 200: the rarest, a single-point path,
// in 46-50. The floor sits at a fifth of it.
const REACHED_FLOOR = 10
const reached = new Map<keyof typeof REACHED, number>()
const note = (key: keyof typeof REACHED, hit: boolean): void => {
  if (hit) reached.set(key, (reached.get(key) ?? 0) + 1)
}

const PROPERTY = 'an edge comment is pinned on the path, at its point nearest the stored anchor'

describe('commentAnchor on a routed edge', () => {
  afterAllFloor([PROPERTY], () => {
    expect(
      Object.fromEntries(
        Object.keys(REACHED).map((key) => [
          key,
          (reached.get(key as keyof typeof REACHED) ?? 0) >= REACHED_FLOOR,
        ]),
      ),
    ).toEqual(Object.fromEntries(Object.keys(REACHED).map((key) => [key, true])))
  })

  fcTest.prop([path, query], withDefaults())(PROPERTY, (vertices, anchor) => {
    const pin = commentAnchor(edgeComment(anchor), EMPTY, () => vertices)

    expect(onPolyline(pin, vertices)).toBe(true)
    const samples = samplesOf(vertices)
    let nearest = samples[0]!
    for (const s of samples) if (distance(s.at, anchor) < distance(nearest.at, anchor)) nearest = s
    expect(distance(pin, anchor)).toBeLessThanOrEqual(distance(nearest.at, anchor) + TOLERANCE)

    const distinct = new Set(vertices.map((v) => `${v.x},${v.y}`)).size
    const onVertex = vertices.some((v) => distance(pin, v) <= TOLERANCE)
    note('single', distinct === 1)
    note('interior', !onVertex)
    note('clamped', distinct > 1 && onVertex)
    note('later', nearest.segment > 0)
  })

  it('never consults the edge lookup for a comment that names no edge', () => {
    // A lookup keyed by id has no answer for "no id"; one that answered
    // anyway must not move a comment that never pointed at an edge.
    let asked = 0
    const anyEdge = () => {
      asked += 1
      return [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ]
    }
    const loose: CanvasComment = { id: 'c', x: 40, y: 30, text: 'free' }
    expect(commentAnchor(loose, EMPTY, anyEdge)).toEqual({ x: 40, y: 30 })
    expect(commentAnchor({ ...loose, targetNodeId: 'gone' }, EMPTY, anyEdge)).toEqual({
      x: 40,
      y: 30,
    })
    expect(asked).toBe(0)
  })
})
