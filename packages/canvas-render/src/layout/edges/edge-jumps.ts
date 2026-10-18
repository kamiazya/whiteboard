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
/**
 * Most candidate pairs one scene examines. The hop caps bound what is
 * drawn, not what is searched: segments that share cells and never cross
 * draw nothing and still cost a pair each. Past this the search stops and
 * draws no further hops, keeping those already found, so the output stays
 * deterministic. A pair is a filed entry read, duplicates included, so the
 * count runs a little ahead of the narrow-phase tests it bounds. Measured
 * in those tests: 4_160 on a 66_000-segment board, 1.3 million beside
 * twenty board-spanning diagonals, both far below it.
 */
const MAX_PAIRS_PER_SCENE = 4_000_000

interface IndexedSegment {
  readonly a: Point
  readonly b: Point
}

/** A segment as the grid files it: its bounds, and the level whose cell suits it. */
interface Placed {
  readonly seg: IndexedSegment
  readonly level: number
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
}

/** Cells grow fourfold per level: level `l` has a cell of 4^l px. */
const cellAt = (level: number): number => 2 ** (2 * level)
/** A segment's extent is at most this many cells of its own level. */
const EXTENT_IN_CELLS = 1
/** Below this a cell would be subnormal and its pad would vanish. */
const MIN_LEVEL = -30
/** The pad around a segment's cells, as a share of the cell. */
const PAD_IN_CELLS = 2 ** -20
/**
 * Where cell lines fall, as a share of the cell. A power-of-two cell would
 * otherwise put its lines on round coordinates, where authored points sit,
 * and the pad would carry every such segment into a neighbouring cell.
 */
const PHASE_IN_CELLS = 0.381966

/**
 * Files a segment, or answers `undefined` for one that can take part in
 * no crossing: a zero extent has no direction (the narrow phase rejects it
 * as degenerate) and a non-finite one turns its arithmetic NaN.
 */
function place(seg: IndexedSegment): Placed | undefined {
  const minX = Math.min(seg.a.x, seg.b.x)
  const maxX = Math.max(seg.a.x, seg.b.x)
  const minY = Math.min(seg.a.y, seg.b.y)
  const maxY = Math.max(seg.a.y, seg.b.y)
  const extent = Math.max(maxX - minX, maxY - minY)
  if (!(extent > 0 && extent < Number.POSITIVE_INFINITY)) return undefined
  // A nonzero extent is at least one ulp of the segment's coordinates, so
  // its cell is too: an index stays under 2^53, and where one would round,
  // two cells merge, which only adds candidates.
  const need = extent / EXTENT_IN_CELLS
  let level = Math.max(MIN_LEVEL, Math.ceil(Math.log2(need) / 2))
  while (cellAt(level) < need) level += 1
  while (level > MIN_LEVEL && cellAt(level - 1) >= need) level -= 1
  return { seg, level, minX, maxX, minY, maxY }
}

/**
 * `floor((v + delta) / cell)`, exact however large `v` is: the cell is a
 * power of two, so `v / cell` and `base * cell` are exact, and the rest is
 * worked in the offset from that cell's corner, where rounding is
 * relative to the cell rather than to `v`.
 */
function cellIndex(v: number, delta: number, cell: number): number {
  const base = Math.floor(v / cell)
  return base + Math.floor((v - base * cell + cell * PHASE_IN_CELLS + delta) / cell)
}

/**
 * The cells of `cell` px that `p`'s LINE passes through, rather than every
 * cell of its bounding box, so a diagonal costs its length and not its
 * area — padded, so rounding at a cell boundary only adds candidates. Each
 * row range is worked relative to the segment's own start, which keeps its
 * rounding relative to the segment and the cell, not to where the board
 * sits.
 */
function cellsOf(p: Placed, cell: number): string[] {
  const { a, b } = p.seg
  const pad = cell * PAD_IN_CELLS
  const dx = b.x - a.x
  const dy = b.y - a.y
  const c0 = cellIndex(a.x, Math.min(0, dx) - pad, cell)
  const c1 = cellIndex(a.x, Math.max(0, dx) + pad, cell)
  const keys: string[] = []
  for (let i = 0; i <= c1 - c0; i++) {
    const cx = c0 + i
    let lo = Math.min(0, dy)
    let hi = Math.max(0, dy)
    if (dx !== 0 && c1 > c0) {
      // The part of the segment inside this column, by its x extent.
      // Offsets from `a.x`: `cx * cell` is exact, a phase-shifted line is not.
      const left = cx * cell - a.x - cell * PHASE_IN_CELLS
      const xL = Math.max(Math.min(0, dx), left)
      const xR = Math.min(Math.max(0, dx), left + cell)
      const oL = (xL / dx) * dy
      const oR = (xR / dx) * dy
      lo = Math.max(lo, Math.min(oL, oR))
      hi = Math.min(hi, Math.max(oL, oR))
    }
    const r0 = cellIndex(a.y, lo - pad, cell)
    const r1 = cellIndex(a.y, hi + pad, cell)
    for (let k = 0; k <= r1 - r0; k++) keys.push(`${cx},${r0 + k}`)
  }
  return keys
}

/** The bounds of every segment one level files natively. */
interface Bounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** True unless `p` lies clear of `box` by more than a sliver of `cell`. */
function reaches(p: Placed, box: Bounds, cell: number): boolean {
  const gap = cell * PAD_IN_CELLS
  return !(
    box.minX - p.maxX > gap ||
    p.minX - box.maxX > gap ||
    box.minY - p.maxY > gap ||
    p.minY - box.maxY > gap
  )
}

interface Level {
  readonly id: number
  readonly cell: number
  readonly bounds: Bounds
  /** Segments filed at this level, by cell. */
  readonly native: Map<string, number[]>
  /** Segments of finer levels, filed here too so this level's own find them. */
  readonly finer: Map<string, number[]>
}

/** The levels one segment takes part in, each with its cells there. */
type Reached = { readonly level: Level; readonly own: boolean; readonly keys: string[] }[]

function file(cells: Map<string, number[]>, keys: readonly string[], index: number): void {
  for (const key of keys) {
    const cell = cells.get(key)
    if (cell === undefined) cells.set(key, [index])
    else cell.push(index)
  }
}

/**
 * The broad phase: a hierarchy of uniform grids. Each segment is filed at
 * the level whose cell is about half its extent, so it touches a
 * handful of cells whatever its length, and no cell is finer than the
 * coordinates' own spacing where it sits — a board anywhere on the number
 * line, beside outliers anywhere else, indexes as it would at the origin.
 *
 * Two segments that meet share a cell holding the meeting point at the
 * COARSER of their two levels: a segment is also filed, as `finer`, at
 * every coarser level whose segments it can reach, and it looks for
 * segments of coarser levels there. Levels are fixed before any segment is
 * filed, so a coarser segment that comes later still finds a finer one
 * that came earlier.
 */
class SegmentGrid {
  /** Every level in use, finest first. */
  private readonly levels: Level[]
  private readonly segments: IndexedSegment[] = []
  private readonly seenStamp: number[] = []
  private stamp = 0

  constructor(all: readonly Placed[]) {
    const byId = new Map<number, Level>()
    for (const p of all) {
      const level = byId.get(p.level)
      if (level === undefined) {
        byId.set(p.level, {
          id: p.level,
          cell: cellAt(p.level),
          bounds: { minX: p.minX, maxX: p.maxX, minY: p.minY, maxY: p.maxY },
          native: new Map(),
          finer: new Map(),
        })
        continue
      }
      const box = level.bounds
      box.minX = Math.min(box.minX, p.minX)
      box.maxX = Math.max(box.maxX, p.maxX)
      box.minY = Math.min(box.minY, p.minY)
      box.maxY = Math.max(box.maxY, p.maxY)
    }
    this.levels = [...byId.values()].sort((x, y) => x.id - y.id)
  }

  /** The levels `p` takes part in, own first, each with its cells there. */
  reach(p: Placed): Reached {
    const reached: Reached = []
    for (const level of this.levels) {
      if (level.id < p.level) continue
      const own = level.id === p.level
      if (!own && !reaches(p, level.bounds, level.cell)) continue
      reached.push({ level, own, keys: cellsOf(p, level.cell) })
    }
    return reached
  }

  /** Filed entries read so far, duplicates included, against MAX_PAIRS_PER_SCENE. */
  private examined = 0

  private takeFiled(cells: Map<string, number[]>, keys: readonly string[], found: number[]): void {
    for (const key of keys) {
      const filed = cells.get(key) ?? []
      this.examined += filed.length
      for (const index of filed) {
        if (this.seenStamp[index] === this.stamp) continue
        this.seenStamp[index] = this.stamp
        found.push(index)
      }
    }
  }

  /**
   * Every segment filed so far that can meet the one `reached` describes,
   * once each and in the order they were filed. The order is fixed because
   * two crossings can tie along a segment while their points differ in the
   * last bits, and the spacing rule keeps whichever comes first.
   * `undefined` once the scene's pair budget is spent.
   */
  candidates(reached: Reached): IndexedSegment[] | undefined {
    this.stamp += 1
    const found: number[] = []
    for (const { level, own, keys } of reached) {
      this.takeFiled(level.native, keys, found)
      // Finer segments are found at their coarser partner's own level only.
      if (own && level.finer.size > 0) this.takeFiled(level.finer, keys, found)
    }
    // Checked per segment, so no segment is searched in part.
    if (this.examined > MAX_PAIRS_PER_SCENE) return undefined
    found.sort((p, q) => p - q)
    return found.map((index) => this.segments[index] as IndexedSegment)
  }

  add(seg: IndexedSegment, reached: Reached): void {
    const index = this.segments.length
    this.segments.push(seg)
    this.seenStamp.push(0)
    for (const { level, own, keys } of reached) file(own ? level.native : level.finer, keys, index)
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
 * An edge's segments by index, filed; a non-finite point cannot be drawn,
 * so a segment touching one neither hops nor is hopped.
 */
function placedSegmentsOf(edge: ResolvedEdgeNode): (Placed | undefined)[] {
  const segments: (Placed | undefined)[] = []
  for (let seg = 0; seg < edge.path.length - 1; seg += 1) {
    const a = edge.path[seg] as Point
    const b = edge.path[seg + 1] as Point
    segments.push(isFinitePoint(a) && isFinitePoint(b) ? place({ a, b }) : undefined)
  }
  return segments
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
  const placed = edges.map(placedSegmentsOf)
  const grid = new SegmentGrid(placed.flat().filter((p): p is Placed => p !== undefined))
  let sceneBudget = MAX_HOPS_PER_SCENE
  edges.forEach((edge, e) => {
    if (sceneBudget === 0) return
    const segments = placed[e] as (Placed | undefined)[]
    const reached = segments.map((p) => (p === undefined ? undefined : grid.reach(p)))
    const jumps: EdgeJumpPoint[] = []
    segments.forEach((p, seg) => {
      const r = reached[seg]
      if (p === undefined || r === undefined || sceneBudget === 0) return
      const { a, b } = p.seg
      const candidates = grid.candidates(r)
      if (candidates === undefined) {
        // The pair budget is spent: no further hops anywhere in the scene,
        // and the remaining segments are not even filed.
        sceneBudget = 0
        return
      }
      const limit = Math.min(MAX_HOPS_PER_SEGMENT, sceneBudget)
      const hops = spacedHops(
        crossingsOn(p.seg, candidates),
        Math.hypot(b.x - a.x, b.y - a.y),
        seg,
        limit,
      )
      sceneBudget -= hops.length
      jumps.push(...hops)
    })
    if (jumps.length > 0) result.set(edge.id, jumps)
    segments.forEach((p, seg) => {
      const r = reached[seg]
      if (p !== undefined && r !== undefined) grid.add(p.seg, r)
    })
  })
  return result
}
