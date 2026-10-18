// Line-jump computation: where one routed edge crosses another, the LATER
// edge in document order (the one painted on top) receives a hop point.
// Pure segment-pair intersection over already-routed polylines — no
// knowledge of styles; rounded corners re-use the same points because
// 'curved' travels the orthogonal waypoints.
import type { EdgeJumpPoint, ResolvedEdgeNode } from '@kamiazya/whiteboard-scene'
import type { Point } from './edge-geometry.js'
import { EDGE_JUMP_RADIUS_PX, segmentIntersection } from './segment-intersection.js'

export { EDGE_JUMP_RADIUS_PX }

interface Crossing {
  readonly point: Point
  /** Where along the jumping segment it falls, 0 at `a1` and 1 at `a2`. */
  readonly t: number
}

/**
 * Most hops one segment draws, and most one scene draws. Every crossing
 * that fits its own arc is otherwise kept, so a crossing-dense board grows
 * its hop list with the product of its edges; past a cap the remaining
 * crossings draw no arc, which reads as a plain crossing rather than as a
 * wrong one.
 */
const MAX_HOPS_PER_SEGMENT = 64
const MAX_HOPS_PER_SCENE = 4096

interface IndexedSegment {
  readonly a: Point
  readonly b: Point
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
}

const indexed = (a: Point, b: Point): IndexedSegment => ({
  a,
  b,
  minX: Math.min(a.x, b.x),
  maxX: Math.max(a.x, b.x),
  minY: Math.min(a.y, b.y),
  maxY: Math.max(a.y, b.y),
})

/**
 * The broad phase: a uniform grid of segments, with a segment entered in
 * every cell its LINE passes through rather than every cell of its bounding
 * box, so a long diagonal costs its length and not its area. Two segments
 * that meet share the cell holding the meeting point, so the narrow phase
 * sees every pair that can cross; the coverage is padded so rounding at a
 * cell boundary only adds candidates.
 *
 * The cell is the mean segment extent: the total number of cell entries is
 * then a small multiple of the segment count, whatever the board's size.
 */
class SegmentGrid {
  private readonly cells = new Map<string, number[]>()
  private readonly segments: IndexedSegment[] = []
  private readonly seenStamp: number[] = []
  private stamp = 0

  constructor(private readonly cellPx: number) {}

  private forEachCell(seg: IndexedSegment, visit: (key: string) => void): void {
    const s = this.cellPx
    // Rounding grows with the coordinates' magnitude, not with the cell.
    const magnitude = Math.max(
      Math.abs(seg.minX),
      Math.abs(seg.maxX),
      Math.abs(seg.minY),
      Math.abs(seg.maxY),
    )
    const pad = s * 1e-6 + magnitude * 1e-9
    const dx = seg.b.x - seg.a.x
    const dy = seg.b.y - seg.a.y
    const c0 = Math.floor((seg.minX - pad) / s)
    const c1 = Math.floor((seg.maxX + pad) / s)
    for (let cx = c0; cx <= c1; cx++) {
      let yLo = seg.minY
      let yHi = seg.maxY
      if (dx !== 0 && c1 > c0) {
        // The part of the segment inside this column, by its x extent.
        const xL = Math.max(seg.minX, cx * s)
        const xR = Math.min(seg.maxX, (cx + 1) * s)
        const yL = seg.a.y + ((xL - seg.a.x) / dx) * dy
        const yR = seg.a.y + ((xR - seg.a.x) / dx) * dy
        yLo = Math.max(seg.minY, Math.min(yL, yR))
        yHi = Math.min(seg.maxY, Math.max(yL, yR))
      }
      const r0 = Math.floor((yLo - pad) / s)
      const r1 = Math.floor((yHi + pad) / s)
      for (let cy = r0; cy <= r1; cy++) visit(`${cx},${cy}`)
    }
  }

  /** Every segment entered so far that shares a cell with `seg`, once each. */
  candidates(seg: IndexedSegment): IndexedSegment[] {
    this.stamp += 1
    const found: IndexedSegment[] = []
    this.forEachCell(seg, (key) => {
      for (const index of this.cells.get(key) ?? []) {
        if (this.seenStamp[index] === this.stamp) continue
        this.seenStamp[index] = this.stamp
        found.push(this.segments[index] as IndexedSegment)
      }
    })
    return found
  }

  add(seg: IndexedSegment): void {
    const index = this.segments.length
    this.segments.push(seg)
    this.seenStamp.push(0)
    this.forEachCell(seg, (key) => {
      const cell = this.cells.get(key)
      if (cell === undefined) this.cells.set(key, [index])
      else cell.push(index)
    })
  }
}

/** Every proper crossing of `seg` by a candidate segment of an earlier edge. */
function crossingsOn(seg: IndexedSegment, earlier: readonly IndexedSegment[]): Crossing[] {
  const { a: a1, b: a2 } = seg
  const len = Math.hypot(a2.x - a1.x, a2.y - a1.y)
  const found: Crossing[] = []
  for (const other of earlier) {
    const hit = segmentIntersection(a1, a2, other.a, other.b)
    if (hit === undefined) continue
    found.push({ point: hit, t: len === 0 ? 0 : Math.hypot(hit.x - a1.x, hit.y - a1.y) / len })
  }
  return found
}

/**
 * The crossings that can each carry their own arc, in order along the
 * segment, at most `limit` of them.
 *
 * Hops closer than a diameter cannot fit as separate arcs — the first arc's
 * exit would sit past the next arc's entry and the path would double back.
 * The first crossing keeps its hop.
 */
function spacedHops(
  crossings: Crossing[],
  segLen: number,
  seg: number,
  limit: number,
): EdgeJumpPoint[] {
  crossings.sort((p, q) => p.t - q.t)
  const kept: EdgeJumpPoint[] = []
  let lastKeptT = Number.NEGATIVE_INFINITY
  for (const { point, t } of crossings) {
    if (kept.length >= limit) break
    if ((t - lastKeptT) * segLen < 2 * EDGE_JUMP_RADIUS_PX) continue
    lastKeptT = t
    kept.push({ segment: seg, x: point.x, y: point.y })
  }
  return kept
}

const isFinitePoint = (p: Point): boolean => Number.isFinite(p.x) && Number.isFinite(p.y)

/**
 * An edge's segments by index; a non-finite point cannot be drawn, so a
 * segment touching one neither hops nor is hopped.
 */
function segmentsOf(edge: ResolvedEdgeNode): (IndexedSegment | undefined)[] {
  const segments: (IndexedSegment | undefined)[] = []
  for (let seg = 0; seg < edge.path.length - 1; seg += 1) {
    const a = edge.path[seg] as Point
    const b = edge.path[seg + 1] as Point
    segments.push(isFinitePoint(a) && isFinitePoint(b) ? indexed(a, b) : undefined)
  }
  return segments
}

function meanSegmentExtent(edges: readonly ResolvedEdgeNode[]): number {
  let total = 0
  let count = 0
  for (const edge of edges) {
    for (let k = 0; k < edge.path.length - 1; k += 1) {
      const a = edge.path[k] as Point
      const b = edge.path[k + 1] as Point
      if (!isFinitePoint(a) || !isFinitePoint(b)) continue
      total += Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
      count += 1
    }
  }
  return count === 0 ? 1 : Math.max(1, total / count)
}

/**
 * Hop points for each edge over every EARLIER edge, keyed by edge id.
 * Later-over-earlier mirrors paint order: the line drawn on top is the one
 * that visibly hops. Jumps on one segment are ordered along its direction.
 */
export function computeEdgeJumps(
  edges: readonly ResolvedEdgeNode[],
): ReadonlyMap<string, readonly EdgeJumpPoint[]> {
  const result = new Map<string, readonly EdgeJumpPoint[]>()
  const grid = new SegmentGrid(meanSegmentExtent(edges))
  let sceneBudget = MAX_HOPS_PER_SCENE
  for (const edge of edges) {
    if (sceneBudget === 0) break
    const segments = segmentsOf(edge)
    const jumps: EdgeJumpPoint[] = []
    segments.forEach((segment, seg) => {
      if (segment === undefined || sceneBudget === 0) return
      const segLen = Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y)
      const limit = Math.min(MAX_HOPS_PER_SEGMENT, sceneBudget)
      const hops = spacedHops(crossingsOn(segment, grid.candidates(segment)), segLen, seg, limit)
      sceneBudget -= hops.length
      jumps.push(...hops)
    })
    if (jumps.length > 0) result.set(edge.id, jumps)
    for (const segment of segments) if (segment !== undefined) grid.add(segment)
  }
  return result
}
