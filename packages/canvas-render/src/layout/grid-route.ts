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

type Axis = 0 | 1

const enteredHorizontally = (axis: Axis) => axis === 0

/**
 * True when the open segment `a`-`b` passes through the strict interior of
 * `rect`. Touching a border is allowed: obstacles are already offset outward
 * by the caller's clearance, so a route riding that offset line is at the
 * intended distance, not grazing the node.
 */
function segmentEntersRect(a: Point, b: Point, rect: Rect): boolean {
  const right = rect.x + rect.w
  const bottom = rect.y + rect.h
  if (a.y === b.y) {
    if (!(a.y > rect.y && a.y < bottom)) return false
    return Math.min(a.x, b.x) < right && Math.max(a.x, b.x) > rect.x
  }
  if (!(a.x > rect.x && a.x < right)) return false
  return Math.min(a.y, b.y) < bottom && Math.max(a.y, b.y) > rect.y
}

/**
 * Length of `a`-`b` lying ON one of `rect`'s borders. Charged rather than
 * forbidden: the anchors themselves sit on a border, so the first and last
 * step of every route trace one by construction and a hard rule would make
 * the target unreachable.
 */
function borderOverlap(a: Point, b: Point, rect: Rect): number {
  const right = rect.x + rect.w
  const bottom = rect.y + rect.h
  if (a.y === b.y && (a.y === rect.y || a.y === bottom)) {
    const lo = Math.max(Math.min(a.x, b.x), rect.x)
    const hi = Math.min(Math.max(a.x, b.x), right)
    return hi > lo ? hi - lo : 0
  }
  if (a.x === b.x && (a.x === rect.x || a.x === right)) {
    const lo = Math.max(Math.min(a.y, b.y), rect.y)
    const hi = Math.min(Math.max(a.y, b.y), bottom)
    return hi > lo ? hi - lo : 0
  }
  return 0
}

const uniqueSorted = (values: readonly number[]) => [...new Set(values)].sort((a, b) => a - b)

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
  const xs = uniqueSorted([
    start.x,
    end.x,
    ...obstacles.flatMap((r) => [r.x - clearance, r.x + r.w + clearance]),
  ])
  const ys = uniqueSorted([
    start.y,
    end.y,
    ...obstacles.flatMap((r) => [r.y - clearance, r.y + r.h + clearance]),
  ])
  if (xs.length * ys.length > MAX_GRID_CELLS) return undefined

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
      const a = { x: xs[i] as number, y: ys[j] as number }
      const b = { x: xs[ni] as number, y: ys[nj] as number }
      if (obstacles.some((rect) => segmentEntersRect(a, b, rect))) continue
      const turn = enteredHorizontally(axis) === enteredHorizontally(nextAxis) ? 0 : BEND_COST_PX
      // A traced border costs its own length again: a line hidden on top of
      // a box's edge is the defect this router would otherwise reintroduce
      // while avoiding the one it exists to fix. Doubling makes going around
      // clearly cheaper without making a border-hugging step impossible.
      const traced = obstacles.reduce((sum, rect) => sum + borderOverlap(a, b, rect), 0)
      const next = cost + Math.abs(b.x - a.x) + Math.abs(b.y - a.y) + turn + traced
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
