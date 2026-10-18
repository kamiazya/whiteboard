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
}

/**
 * Most cells one segment is entered in. A segment that would take more —
 * one far longer than the board's mean, or one whose coordinates leave no
 * room for a cell index — is checked against every segment instead, which
 * keeps the result exact while bounding what the grid can be made to walk.
 */
const MAX_CELLS_PER_SEGMENT = 1024

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
 * Cells are counted from the board's own top-left, not from 0, so a board
 * drawn far from the origin indexes as it would at the origin — coordinates
 * are unbounded, and an index taken from them directly outgrows both the
 * pad and, past 2^53, the loop counter itself.
 */
class SegmentGrid {
  private readonly cells = new Map<string, number[]>()
  private readonly segments: IndexedSegment[] = []
  private readonly seenStamp: number[] = []
  /** Segments in no cell, which every segment is checked against. */
  private readonly wide: number[] = []
  private stamp = 0

  constructor(
    private readonly cellPx: number,
    private readonly originX: number,
    private readonly originY: number,
  ) {}

  /**
   * The cells `seg` is entered in, or `undefined` when it is too wide for
   * the grid: past the cell cap, or where an index is no longer an exact
   * integer. Rounding in relative coordinates scales with how far a segment
   * sits from the board's top-left, not from 0, so the pad is a sliver of
   * the cell plus a few dozen ulps of that offset.
   */
  cellsOf(seg: IndexedSegment): string[] | undefined {
    const s = this.cellPx
    const ax = seg.a.x - this.originX
    const ay = seg.a.y - this.originY
    const bx = seg.b.x - this.originX
    const by = seg.b.y - this.originY
    const minX = Math.min(ax, bx)
    const maxX = Math.max(ax, bx)
    const minY = Math.min(ay, by)
    const maxY = Math.max(ay, by)
    const offset = Math.max(maxX, maxY, -minX, -minY)
    const pad = s * 1e-6 + offset * 2 ** -46
    const c0 = Math.floor((minX - pad) / s)
    const c1 = Math.floor((maxX + pad) / s)
    const rowLo = Math.floor((minY - pad) / s)
    const rowHi = Math.floor((maxY + pad) / s)
    if (![c0, c1, rowLo, rowHi].every(Number.isSafeInteger)) return undefined
    // Bounds the column loop by itself, whatever each column contributes.
    if (c1 - c0 + 1 > MAX_CELLS_PER_SEGMENT) return undefined
    const dx = bx - ax
    const dy = by - ay
    const keys: string[] = []
    // Counted loops: termination never rests on `cx + 1` differing from `cx`.
    for (let i = 0; i <= c1 - c0; i++) {
      const cx = c0 + i
      let yLo = minY
      let yHi = maxY
      if (dx !== 0 && c1 > c0) {
        // The part of the segment inside this column, by its x extent.
        const xL = Math.max(minX, cx * s)
        const xR = Math.min(maxX, (cx + 1) * s)
        const yL = ay + ((xL - ax) / dx) * dy
        const yR = ay + ((xR - ax) / dx) * dy
        yLo = Math.max(minY, Math.min(yL, yR))
        yHi = Math.min(maxY, Math.max(yL, yR))
      }
      const r0 = Math.floor((yLo - pad) / s)
      const r1 = Math.floor((yHi + pad) / s)
      if (keys.length + (r1 - r0 + 1) > MAX_CELLS_PER_SEGMENT) return undefined
      for (let k = 0; k <= r1 - r0; k++) keys.push(`${cx},${r0 + k}`)
    }
    return keys
  }

  private take(index: number, found: number[]): void {
    if (this.seenStamp[index] === this.stamp) return
    this.seenStamp[index] = this.stamp
    found.push(index)
  }

  /**
   * Every segment entered so far that can meet `seg`, once each and in the
   * order they were entered: those sharing one of its cells and every wide
   * one — or, when `seg` is wide itself, all of them. The order is fixed
   * because two crossings can tie along a segment while their points differ
   * in the last bits, and the spacing rule keeps whichever comes first.
   */
  candidates(keys: readonly string[] | undefined): IndexedSegment[] {
    if (keys === undefined) return [...this.segments]
    this.stamp += 1
    const found: number[] = []
    for (const key of keys) for (const index of this.cells.get(key) ?? []) this.take(index, found)
    for (const index of this.wide) this.take(index, found)
    return found.sort((p, q) => p - q).map((index) => this.segments[index] as IndexedSegment)
  }

  add(seg: IndexedSegment, keys: readonly string[] | undefined): void {
    const index = this.segments.length
    this.segments.push(seg)
    this.seenStamp.push(0)
    if (keys === undefined) {
      this.wide.push(index)
      return
    }
    for (const key of keys) {
      const cell = this.cells.get(key)
      if (cell === undefined) this.cells.set(key, [index])
      else cell.push(index)
    }
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
    segments.push(isFinitePoint(a) && isFinitePoint(b) ? { a, b } : undefined)
  }
  return segments
}

/** The grid's cell (the mean segment extent) and origin (the board's top-left). */
function gridFrame(edges: readonly ResolvedEdgeNode[]): { cellPx: number; x: number; y: number } {
  let total = 0
  let count = 0
  let x = Number.POSITIVE_INFINITY
  let y = Number.POSITIVE_INFINITY
  for (const edge of edges) {
    for (let k = 0; k < edge.path.length - 1; k += 1) {
      const a = edge.path[k] as Point
      const b = edge.path[k + 1] as Point
      if (!isFinitePoint(a) || !isFinitePoint(b)) continue
      total += Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
      count += 1
      x = Math.min(x, a.x, b.x)
      y = Math.min(y, a.y, b.y)
    }
  }
  // An overflowing total leaves every segment wide, which is exact.
  const cellPx = count === 0 ? 1 : Math.max(1, total / count)
  return count === 0 ? { cellPx, x: 0, y: 0 } : { cellPx, x, y }
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
  const frame = gridFrame(edges)
  const grid = new SegmentGrid(frame.cellPx, frame.x, frame.y)
  let sceneBudget = MAX_HOPS_PER_SCENE
  for (const edge of edges) {
    if (sceneBudget === 0) break
    const segments = segmentsOf(edge)
    const keys = segments.map((segment) =>
      segment === undefined ? undefined : grid.cellsOf(segment),
    )
    const jumps: EdgeJumpPoint[] = []
    segments.forEach((segment, seg) => {
      if (segment === undefined || sceneBudget === 0) return
      const segLen = Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y)
      const limit = Math.min(MAX_HOPS_PER_SEGMENT, sceneBudget)
      const hops = spacedHops(crossingsOn(segment, grid.candidates(keys[seg])), segLen, seg, limit)
      sceneBudget -= hops.length
      jumps.push(...hops)
    })
    if (jumps.length > 0) result.set(edge.id, jumps)
    segments.forEach((segment, seg) => {
      if (segment !== undefined) grid.add(segment, keys[seg])
    })
  }
  return result
}
