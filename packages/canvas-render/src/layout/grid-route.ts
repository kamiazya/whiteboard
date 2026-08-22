import type { Point, Rect } from './edge-rules.js'

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

const enteredHorizontally = (axis: Axis) => axis === 0

/**
 * The cheapest rectilinear path from `start` to `end` whose interior avoids
 * every rect in `obstacles`, or undefined when there is none (or the grid is
 * too large to search). The returned path always begins at `start` and ends
 * at `end`, with collinear intermediate points removed.
 */
export function routeOnGrid(
  start: Point,
  end: Point,
  obstacles: readonly Rect[],
  clearance: number,
): Point[] | undefined {
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
  const xs = [...xSet].sort((a, b) => a - b)
  const ys = [...ySet].sort((a, b) => a - b)

  const si = xs.indexOf(start.x)
  const sj = ys.indexOf(start.y)
  const ei = xs.indexOf(end.x)
  const ej = ys.indexOf(end.y)
  if (si < 0 || sj < 0 || ei < 0 || ej < 0) return undefined

  const width = xs.length
  // Two states per cell — arrived horizontally or vertically — so a turn can
  // be charged. Collapsing them would make the first arrival win regardless
  // of how many corners it took to get there.
  const stateOf = (i: number, j: number, axis: Axis) => (j * width + i) * 2 + axis
  const best = new Map<number, number>()
  const cameFrom = new Map<number, number>()
  // A small binary heap: the grid is bounded but still large enough that a
  // linear scan per pop dominates the search.
  const heap: { cost: number; state: number }[] = []
  const push = (cost: number, state: number) => {
    heap.push({ cost, state })
    let child = heap.length - 1
    while (child > 0) {
      const parent = (child - 1) >> 1
      if ((heap[parent] as { cost: number }).cost <= (heap[child] as { cost: number }).cost) break
      const swap = heap[parent] as { cost: number; state: number }
      heap[parent] = heap[child] as { cost: number; state: number }
      heap[child] = swap
      child = parent
    }
  }
  const pop = () => {
    const top = heap[0] as { cost: number; state: number }
    const last = heap.pop() as { cost: number; state: number }
    if (heap.length > 0) {
      heap[0] = last
      let parent = 0
      for (;;) {
        const left = parent * 2 + 1
        const right = left + 1
        let smallest = parent
        if (
          left < heap.length &&
          (heap[left] as { cost: number }).cost < (heap[smallest] as { cost: number }).cost
        )
          smallest = left
        if (
          right < heap.length &&
          (heap[right] as { cost: number }).cost < (heap[smallest] as { cost: number }).cost
        )
          smallest = right
        if (smallest === parent) break
        const swap = heap[parent] as { cost: number; state: number }
        heap[parent] = heap[smallest] as { cost: number; state: number }
        heap[smallest] = swap
        parent = smallest
      }
    }
    return top
  }

  for (const axis of [0, 1] as const) {
    best.set(stateOf(si, sj, axis), 0)
    push(0, stateOf(si, sj, axis))
  }

  const steps: readonly (readonly [number, number, Axis])[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 1],
    [0, -1, 1],
  ]

  // Obstacles bucketed by the grid line a step travels along. Every step is
  // axis-aligned, so a horizontal one at `ys[j]` can only be BLOCKED by a
  // rect whose interior strictly spans that y — touching a border is
  // allowed, since obstacles are already offset outward by the caller's
  // clearance and a route riding that offset line is at the intended
  // distance — and can only TRACE the border of one whose top or bottom IS
  // that y. Bucketing costs lines * obstacles once; scanning every obstacle
  // per neighbour cost pops * 4 * obstacles, and a search that finds nothing
  // still expands every reachable cell — which two thirds of them do.
  const bucket = (
    values: readonly number[],
    lo: (r: Rect) => number,
    size: (r: Rect) => number,
  ) => ({
    blockers: values.map((v) => near.filter((r) => v > lo(r) && v < lo(r) + size(r))),
    borders: values.map((v) => near.filter((r) => v === lo(r) || v === lo(r) + size(r))),
  })
  const rows = bucket(
    ys,
    (r) => r.y,
    (r) => r.h,
  )
  const cols = bucket(
    xs,
    (r) => r.x,
    (r) => r.w,
  )

  let goal: number | undefined
  while (heap.length > 0) {
    const { cost, state } = pop()
    if ((best.get(state) ?? Number.POSITIVE_INFINITY) < cost) continue
    const axis = (state % 2) as Axis
    const cell = (state - axis) / 2
    const i = cell % width
    const j = (cell - i) / width
    if (i === ei && j === ej) {
      goal = state
      break
    }
    for (const [di, dj, nextAxis] of steps) {
      const ni = i + di
      const nj = j + dj
      if (ni < 0 || nj < 0 || ni >= xs.length || nj >= ys.length) continue
      const horizontal = dj === 0
      const line = horizontal ? rows : cols
      const index = horizontal ? j : i
      const from = (horizontal ? xs[i] : ys[j]) as number
      const to = (horizontal ? xs[ni] : ys[nj]) as number
      const lo = Math.min(from, to)
      const hi = Math.max(from, to)
      const near0 = horizontal ? (r: Rect) => r.x : (r: Rect) => r.y
      const size0 = horizontal ? (r: Rect) => r.w : (r: Rect) => r.h
      if (
        (line.blockers[index] as readonly Rect[]).some(
          (rect) => lo < near0(rect) + size0(rect) && hi > near0(rect),
        )
      ) {
        continue
      }
      const turn = enteredHorizontally(axis) === enteredHorizontally(nextAxis) ? 0 : BEND_COST_PX
      // Tracing a border is CHARGED, not forbidden: the anchors themselves
      // sit on one, so the first and last step of every route traces a
      // border by construction and a hard rule would make the target
      // unreachable. The charge is the traced length again — a line hidden
      // on a box's edge is the defect this router would otherwise
      // reintroduce while avoiding the one it exists to fix — which makes
      // going around clearly cheaper without making the step impossible.
      let traced = 0
      for (const rect of line.borders[index] as readonly Rect[]) {
        const overlapLo = Math.max(lo, near0(rect))
        const overlapHi = Math.min(hi, near0(rect) + size0(rect))
        if (overlapHi > overlapLo) traced += overlapHi - overlapLo
      }
      const next = cost + (hi - lo) + turn + traced
      const nextState = stateOf(ni, nj, nextAxis)
      if (next >= (best.get(nextState) ?? Number.POSITIVE_INFINITY)) continue
      best.set(nextState, next)
      cameFrom.set(nextState, state)
      push(next, nextState)
    }
  }
  if (goal === undefined) return undefined

  const reversed: Point[] = []
  for (let state: number | undefined = goal; state !== undefined; state = cameFrom.get(state)) {
    const axis = state % 2
    const cell = (state - axis) / 2
    const i = cell % width
    const j = (cell - i) / width
    const point = { x: xs[i] as number, y: ys[j] as number }
    const last = reversed[reversed.length - 1]
    if (last === undefined || last.x !== point.x || last.y !== point.y) reversed.push(point)
  }
  reversed.reverse()

  // Both start states seed the search, so the walk back can end on either;
  // collinear runs collapse to their endpoints.
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
