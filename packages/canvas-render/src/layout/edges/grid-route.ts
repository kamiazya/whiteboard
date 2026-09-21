import type { Point, Rect } from './edge-rules.js'
import { MinHeap } from './min-heap.js'

/**
 * A rectilinear shortest path around rectangles, used ONLY as a fallback
 * when the enumerated candidates in `spatial-edges.ts` all fail.
 *
 * The enumerated family — two elbows plus four ways around one bounding box —
 * handles the arrangements that actually occur, cheaply, and is what runs for
 * almost every edge. What it cannot do is thread BETWEEN obstacles: measured
 * across 2000 generated layouts, 67 of the 68 routes that still cut through a
 * node body had a clean rectilinear path available that no candidate in that
 * family expressed. This finds those.
 *
 * The search space is the Hanan grid — every obstacle border offset outward by
 * `clearance`, plus the two endpoints' own coordinates. A rectilinear shortest
 * path among rectangles always exists on that grid if it exists at all, so
 * nothing is lost by not searching the continuous plane. Cost is Manhattan
 * length plus a per-corner charge, which is what makes it prefer the straight
 * route over an equally-long staircase.
 *
 * Deliberately NOT the default path: it is O(n^2) grid nodes for n obstacles
 * and runs a priority search over them, against a handful of array operations
 * for the enumerated candidates. `MAX_GRID_CELLS` abandons the search rather
 * than spend an unbounded amount of time on a dense canvas — the caller keeps
 * its best enumerated candidate, exactly as before this existed.
 */

/** Charge per corner, in px. Two routes of equal length differ only in how
 * many times they turn, and a reader prefers the one that turns less. Sized
 * against a typical node so a detour is worth taking to remove a pair of
 * corners, but never worth a large excursion. */
const BEND_COST_PX = 80

/** Above this the grid is abandoned rather than searched. A 12x12 obstacle
 * neighbourhood is already past what the enumerated candidates fail on. */
const MAX_GRID_CELLS = 4096

/**
 * How far past the endpoints' bounding box the search may wander, in px.
 * Swept against the routing scoreboard: 80 loses routes the corpus needs
 * (violations 29 -> 37), 320 matches an unbounded grid on the corpus while
 * costing 25% more time on a large canvas, and 160 beats both — fewer
 * violations and less interior ink than the unbounded grid on the corpus,
 * because a detour that has to wander that far tends to create the defects
 * it was avoiding.
 */
const GRID_WINDOW_PX = 160

type Axis = 0 | 1

/**
 * One move on the grid, with everything that follows from its DIRECTION.
 *
 * The successor loop used to re-derive all of this from `dj === 0` at every
 * step — seven `horizontal ? … : …` between reading the cell and charging
 * the move, two of them allocating a fresh arrow function per step on the
 * hottest path in routing (measured at 16-27% of layout). Declared once here
 * the branches are gone from the loop and the accessors are allocated once
 * for the process, not once per expansion.
 */
interface GridStep {
  readonly di: number
  readonly dj: number
  /**
   * The axis this step travels — and, since a step never turns mid-move, the
   * axis it ARRIVES on, which is what the bend charge compares. It indexes
   * the search's paired data, so no site re-derives it.
   */
  readonly axis: Axis
  /** The cell index ALONG the travelled axis: `i` on a row, `j` on a column. */
  readonly along: (i: number, j: number) => number
  /** The cell index ACROSS it, which names the line the step travels on. */
  readonly across: (i: number, j: number) => number
  /** A rect's near coordinate along the travelled axis. */
  readonly near: (r: Rect) => number
  /** A rect's extent along that same axis. */
  readonly size: (r: Rect) => number
}

const ALONG_ROW = {
  axis: 0,
  along: (i: number, _j: number) => i,
  across: (_i: number, j: number) => j,
  near: (r: Rect) => r.x,
  size: (r: Rect) => r.w,
} as const
const ALONG_COLUMN = {
  axis: 1,
  along: (_i: number, j: number) => j,
  across: (i: number, _j: number) => i,
  near: (r: Rect) => r.y,
  size: (r: Rect) => r.h,
} as const

const GRID_STEPS: readonly GridStep[] = [
  { di: 1, dj: 0, ...ALONG_ROW },
  { di: -1, dj: 0, ...ALONG_ROW },
  { di: 0, dj: 1, ...ALONG_COLUMN },
  { di: 0, dj: -1, ...ALONG_COLUMN },
]

/** Whether any rect on this line has the span `lo..hi` strictly in its interior. */
function spanBlocked(blockers: readonly Rect[], step: GridStep, lo: number, hi: number): boolean {
  return blockers.some((rect) => lo < step.near(rect) + step.size(rect) && hi > step.near(rect))
}

/**
 * How much of `lo..hi` runs along a rect's border.
 *
 * Tracing a border is CHARGED, not forbidden: the anchors themselves sit on
 * one, so the first and last step of every route traces a border by
 * construction and a hard rule would make the target unreachable. The charge
 * is the traced length again — a line hidden on a box's edge is the defect
 * this router would otherwise reintroduce while avoiding the one it exists
 * to fix — which makes going around clearly cheaper without making the step
 * impossible.
 */
function tracedAlong(borders: readonly Rect[], step: GridStep, lo: number, hi: number): number {
  let traced = 0
  for (const rect of borders) {
    const overlapLo = Math.max(lo, step.near(rect))
    const overlapHi = Math.min(hi, step.near(rect) + step.size(rect))
    if (overlapHi > overlapLo) traced += overlapHi - overlapLo
  }
  return traced
}

/**
 * The cheapest rectilinear path from `start` to `end` whose interior avoids
 * every rect in `obstacles`, or undefined when there is none (or the grid is
 * too large to search). The returned path always begins at `start` and ends
 * at `end`, with collinear intermediate points removed.
 */
/** The Hanan grid for this pair of endpoints, or undefined when it would be
 *  larger than `MAX_GRID_CELLS`. `near` is every obstacle a path inside the
 *  search window could touch, so a search over this grid is exact there.
 *  (No sentence here ends on the word `window` followed by a full stop:
 *  import-guard.test.ts scans this file's raw TEXT for `/\bwindow\./`, and
 *  prose satisfies that pattern as readily as a DOM access does.) */
/** The Hanan grid's lines, plus every obstacle reaching into the searched box. */
interface Grid {
  readonly xs: number[]
  readonly ys: number[]
  readonly near: readonly Rect[]
}

function buildGrid(
  start: Point,
  end: Point,
  obstacles: readonly Rect[],
  clearance: number,
): Grid | undefined {
  // The search is confined to a window around the two endpoints: only
  // obstacles that reach into it are considered, and only their grid
  // coordinates inside it. Every obstacle a path inside the window could
  // touch is therefore in the list, so the result is exact for that window;
  // a route that would have to leave it is simply not found, and the caller
  // keeps its enumerated candidate — the same answer a whole-canvas grid
  // gave past the cell cap, which on a canvas of a few hundred nodes was
  // every call. The window is what lets a large canvas reach this search
  // at all.
  const minX = Math.min(start.x, end.x) - GRID_WINDOW_PX
  const maxX = Math.max(start.x, end.x) + GRID_WINDOW_PX
  const minY = Math.min(start.y, end.y) - GRID_WINDOW_PX
  const maxY = Math.max(start.y, end.y) + GRID_WINDOW_PX
  const near = obstacles.filter(
    (r) =>
      r.x - clearance <= maxX &&
      r.x + r.w + clearance >= minX &&
      r.y - clearance <= maxY &&
      r.y + r.h + clearance >= minY,
  )
  // Distinct coordinates first, sorting only once the grid is known to fit:
  // on a canvas past the cap every call used to build and sort both axes
  // just to abandon them.
  const xSet = new Set<number>([start.x, end.x])
  const ySet = new Set<number>([start.y, end.y])
  const addX = (x: number) => {
    if (x >= minX && x <= maxX) xSet.add(x)
  }
  const addY = (y: number) => {
    if (y >= minY && y <= maxY) ySet.add(y)
  }
  for (const r of near) {
    addX(r.x - clearance)
    addX(r.x + r.w + clearance)
    addY(r.y - clearance)
    addY(r.y + r.h + clearance)
  }
  if (xSet.size * ySet.size > MAX_GRID_CELLS) return undefined
  return {
    xs: [...xSet].sort((a, b) => a - b),
    ys: [...ySet].sort((a, b) => a - b),
    near,
  }
}

/**
 * Obstacles bucketed by the grid line a step travels along.
 *
 * Every step is axis-aligned, so a horizontal one at `ys[j]` can only be
 * BLOCKED by a rect whose interior strictly spans that y — touching a border
 * is allowed, since obstacles are already offset outward by the caller's
 * clearance and a route riding that offset line is at the intended distance —
 * and can only TRACE the border of one whose top or bottom IS that y.
 * Bucketing costs lines * obstacles once; scanning every obstacle per
 * neighbour cost pops * 4 * obstacles, and a search that finds nothing still
 * expands every reachable cell — which two thirds of them do.
 */
interface LineBuckets {
  readonly blockers: (readonly Rect[])[]
  readonly borders: (readonly Rect[])[]
}

function bucketByLine(
  values: readonly number[],
  near: readonly Rect[],
  lo: (r: Rect) => number,
  size: (r: Rect) => number,
): LineBuckets {
  return {
    blockers: values.map((v) => near.filter((r) => v > lo(r) && v < lo(r) + size(r))),
    borders: values.map((v) => near.filter((r) => v === lo(r) || v === lo(r) + size(r))),
  }
}

/**
 * The grid cells `cameFrom` chains back from `goal`, as points, with repeats
 * and collinear runs collapsed. Undefined when fewer than two points survive.
 *
 * Both start states seed the search, so the walk back can end on either —
 * which is why the same cell can appear twice and the first loop dedupes.
 */
function reconstructPath(
  goal: number,
  cameFrom: Int32Array,
  xs: readonly number[],
  ys: readonly number[],
  width: number,
): Point[] | undefined {
  const reversed: Point[] = []
  for (let state = goal; state >= 0; state = cameFrom[state] as number) {
    const axis = state % 2
    const cell = (state - axis) / 2
    const i = cell % width
    const j = (cell - i) / width
    const point = { x: xs[i] as number, y: ys[j] as number }
    const last = reversed[reversed.length - 1]
    if (last === undefined || last.x !== point.x || last.y !== point.y) reversed.push(point)
  }
  reversed.reverse()

  const path: Point[] = []
  for (const point of reversed) {
    const a = path[path.length - 2]
    const b = path[path.length - 1]
    if (
      a !== undefined &&
      b !== undefined &&
      ((a.x === b.x && b.x === point.x) || (a.y === b.y && b.y === point.y))
    ) {
      path[path.length - 1] = point
      continue
    }
    path.push(point)
  }
  return path.length >= 2 ? path : undefined
}

/**
 * The cheapest rectilinear path from `start` to `end` whose interior avoids
 * every rect in `obstacles`, or undefined when there is none (or the grid is
 * too large to search). The returned path always begins at `start` and ends
 * at `end`, with collinear intermediate points removed.
 */
/**
 * The state the A* search runs over: the grid's lines, the obstacles
 * bucketed per line, and the dense arrays indexed by state.
 *
 * Built once per call and handed to the search whole, because every field is
 * read on the hot path and threading seven parameters would put the same
 * bundle back as an argument list.
 */
interface GridSearch {
  readonly xs: readonly number[]
  readonly ys: readonly number[]
  readonly width: number
  /** The grid's lines, indexed by a step's own axis: `[xs, ys]`. */
  readonly coords: readonly [readonly number[], readonly number[]]
  /** Obstacles bucketed per line, indexed the same way: `[rows, cols]`. */
  readonly lines: readonly [LineBuckets, LineBuckets]
  readonly best: Float64Array
  readonly cameFrom: Int32Array
  /** Manhattan distance from a cell to the goal. */
  readonly heuristic: (i: number, j: number) => number
  /** Two states per cell — arrived horizontally or vertically. */
  readonly stateOf: (i: number, j: number, axis: Axis) => number
}

/**
 * A* rather than Dijkstra: the priority is `g + h` with `h` the Manhattan
 * distance to the goal. That is ADMISSIBLE (a step's cost is its own
 * Manhattan length plus a non-negative bend charge, so no remaining route is
 * ever cheaper than the straight-line remainder) and CONSISTENT (the same
 * inequality applies edge by edge), which is what makes the first pop of the
 * goal optimal — the guarantee plain Dijkstra was relying on, kept.
 *
 * Worth doing because this search is the expensive part of routing and it
 * was expanding the grid blind: measured 161k pops per layout on a 345-edge
 * clustered canvas, 331 per call over grids averaging 422 cells.
 *
 * Two states per cell so a turn can be CHARGED. Collapsing them would make
 * the first arrival win regardless of how many corners it took to get there.
 */
function prepareSearch(grid: Grid, ei: number, ej: number): GridSearch {
  const { xs, ys, near } = grid
  const width = xs.length
  const goalX = xs[ei] as number
  const goalY = ys[ej] as number
  const stateCount = width * ys.length * 2
  // A step travelling a ROW is blocked and charged by the obstacles bucketed
  // per y line, and vice versa — so the pair is ordered to be indexed by the
  // step's own axis rather than picked with a branch at every expansion.
  const rows = bucketByLine(
    ys,
    near,
    (r) => r.y,
    (r) => r.h,
  )
  const cols = bucketByLine(
    xs,
    near,
    (r) => r.x,
    (r) => r.w,
  )
  return {
    xs,
    ys,
    width,
    coords: [xs, ys],
    lines: [rows, cols],
    // Dense arrays rather than Maps: the state space is bounded by
    // MAX_GRID_CELLS and every pop reads and writes both.
    best: new Float64Array(stateCount).fill(Number.POSITIVE_INFINITY),
    cameFrom: new Int32Array(stateCount).fill(-1),
    heuristic: (i, j) => Math.abs((xs[i] as number) - goalX) + Math.abs((ys[j] as number) - goalY),
    stateOf: (i, j, axis) => (j * width + i) * 2 + axis,
  }
}

/** Relax every move out of `state` at cell (i, j), arrived on `axis`. */
function expand(g: GridSearch, heap: MinHeap, state: number, axis: Axis, i: number, j: number) {
  for (const step of GRID_STEPS) {
    const ni = i + step.di
    const nj = j + step.dj
    if (ni < 0 || nj < 0 || ni >= g.xs.length || nj >= g.ys.length) continue
    const line = g.lines[step.axis]
    const index = step.across(i, j)
    const along = g.coords[step.axis]
    const from = along[step.along(i, j)] as number
    const to = along[step.along(ni, nj)] as number
    const lo = Math.min(from, to)
    const hi = Math.max(from, to)
    if (spanBlocked(line.blockers[index] as readonly Rect[], step, lo, hi)) continue
    const turn = axis === step.axis ? 0 : BEND_COST_PX
    const traced = tracedAlong(line.borders[index] as readonly Rect[], step, lo, hi)
    // The successor's g accumulates from `best[state]`, never from the popped
    // f — adding to f instead would charge the heuristic once per step and
    // stop being a shortest-path search at all.
    const next = (g.best[state] as number) + (hi - lo) + turn + traced
    const nextState = g.stateOf(ni, nj, step.axis)
    if (next >= (g.best[nextState] as number)) continue
    g.best[nextState] = next
    g.cameFrom[nextState] = state
    heap.push(next + g.heuristic(ni, nj), nextState)
  }
}

/** The goal state the search settles on, or undefined when it is unreachable. */
function searchGrid(g: GridSearch, si: number, sj: number, ei: number, ej: number) {
  const heap = new MinHeap()
  for (const axis of [0, 1] as const) {
    g.best[g.stateOf(si, sj, axis)] = 0
    heap.push(g.heuristic(si, sj), g.stateOf(si, sj, axis))
  }
  while (heap.size > 0) {
    const { cost, value: state } = heap.pop() as { cost: number; value: number }
    const axis = (state % 2) as Axis
    const cell = (state - axis) / 2
    const i = cell % g.width
    const j = (cell - i) / g.width
    // `best` holds g while the heap is ordered by f, so the stale test adds
    // the same `h` back rather than comparing the two spaces directly.
    if ((g.best[state] as number) + g.heuristic(i, j) < cost) continue
    if (i === ei && j === ej) return state
    expand(g, heap, state, axis, i, j)
  }
  return undefined
}

export function routeOnGrid(
  start: Point,
  end: Point,
  obstacles: readonly Rect[],
  clearance: number,
): Point[] | undefined {
  const grid = buildGrid(start, end, obstacles, clearance)
  if (grid === undefined) return undefined
  const si = grid.xs.indexOf(start.x)
  const sj = grid.ys.indexOf(start.y)
  const ei = grid.xs.indexOf(end.x)
  const ej = grid.ys.indexOf(end.y)
  if (si < 0 || sj < 0 || ei < 0 || ej < 0) return undefined
  const search = prepareSearch(grid, ei, ej)
  const goal = searchGrid(search, si, sj, ei, ej)
  if (goal === undefined) return undefined
  return reconstructPath(goal, search.cameFrom, search.xs, search.ys, search.width)
}
