/**
 * The straight style's way round what is in its way: the shortest path
 * through the corners of the boxes actually blocking it.
 *
 * A straight connection reads as one line, so when something stands between
 * its ends the drawing that stays closest to that reading bends at the corner
 * of the box in the way — once, where one corner clears it, or once per box
 * when several do. Stepping round one box covering everything in the way at
 * once drew a short connection as a long right-angle detour, several times
 * the direct distance, whenever two blockers sat far apart across the line.
 *
 * A shortest path in the plane amid rectangles turns only at their corners,
 * so the search is a visibility graph over those corners. It grows lazily:
 * it starts from the boxes the direct line meets and adds a box's corners
 * only once a leg it tried has run into that box, so a route on a crowded
 * canvas pays for the few boxes near it rather than for the canvas.
 *
 * Beside it, what decides how such a route meets its two boxes: whether a
 * leg runs along the side it ends on (`approachesSideways`), and the stub
 * that squares a detour's glancing end (`squareEnds`).
 */

import type { EdgeSide } from '@kamiazya/whiteboard-model'
import type { Point, Rect } from './edge-geometry.js'
import { containsPoint, outwardNormal, segmentCrossesRect } from './edge-geometry.js'

/**
 * Something a leg must not cross. `block` is the rect the leg is tested
 * against; `body` is the box whose corners the route may turn at.
 */
export interface DetourObstacle {
  readonly block: Rect
  readonly body: Rect
  /**
   * Tested as `body` instead of `block` for a leg ending inside `block` — an
   * anchor in a neighbour's margin band has to cross the band to escape it,
   * and the band is a preference while the body is not.
   */
  readonly escapable: boolean
}

/** Past this many boxes in the way the search gives up, and the caller decides. */
const MAX_BLOCKERS = 24

/** Rounds of "a leg met a box nobody had added yet". */
const MAX_ROUNDS = 6

/**
 * Charged per waypoint, in px, so that of two routes of nearly one length the
 * one with fewer corners wins: a corner is what makes a line stop reading as
 * one.
 */
const CORNER_COST_PX = 4

/**
 * The shortest path from `start` to `end` turning only at the corners of
 * `obstacles`' bodies grown by `clearance`, or `undefined` when none was found
 * within the search's budget. The direct segment when nothing blocks it.
 */
export function cornerDetour(
  start: Point,
  end: Point,
  obstacles: readonly DetourObstacle[],
  clearance: number,
): Point[] | undefined {
  const blockerOf = firstBlocker(obstacles)
  const first = blockerOf(start, end)
  if (first === undefined) return [start, end]

  // Vertices only ever join, so an index names the same point in every
  // round and a leg tested once is never tested again.
  const vertices: Point[] = [start, end]
  const added = new Set<number>()
  const add = (i: number) => {
    added.add(i)
    vertices.push(...cornersOf(obstacles[i] as DetourObstacle, obstacles, clearance))
  }
  add(first)
  const legs = new Map<number, number>()
  const CLEAR = -1
  const leg = (u: number, v: number): number => {
    const key = u < v ? u * 4096 + v : v * 4096 + u
    let hit = legs.get(key)
    if (hit === undefined) {
      hit = blockerOf(vertices[u] as Point, vertices[v] as Point) ?? CLEAR
      legs.set(key, hit)
    }
    return hit
  }

  let best: Point[] | undefined
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const met = new Set<number>()
    best = shortestThrough(vertices, (u, v) => {
      const hit = leg(u, v)
      if (hit !== CLEAR && !added.has(hit)) met.add(hit)
      return hit === CLEAR
    })
    if (met.size === 0 || added.size + met.size > MAX_BLOCKERS) return best
    for (const i of [...met].sort((a, b) => a - b)) add(i)
  }
  return best
}

/**
 * The index of the first obstacle the leg `a`->`b` runs into, testing an
 * escapable obstacle by its body for a leg with an end inside its block.
 */
function firstBlocker(
  obstacles: readonly DetourObstacle[],
): (a: Point, b: Point) => number | undefined {
  return (a: Point, b: Point): number | undefined => {
    const minX = Math.min(a.x, b.x)
    const maxX = Math.max(a.x, b.x)
    const minY = Math.min(a.y, b.y)
    const maxY = Math.max(a.y, b.y)
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i] as DetourObstacle
      const { block } = o
      // Most boxes are nowhere near a given leg; reject those before the
      // escape test, which costs two containment checks.
      if (
        maxX < block.x ||
        minX > block.x + block.w ||
        maxY < block.y ||
        minY > block.y + block.h
      ) {
        continue
      }
      // Escaped by the strict interior, so a leg may leave a point on the
      // body's own border: an anchor can touch a box it does not connect.
      const rect =
        o.escapable && (containsPoint(o.block, a) || containsPoint(o.block, b))
          ? strictInterior(o.body)
          : o.block
      if (segmentCrossesRect(a, b, rect)) return i
    }
    return undefined
  }
}

/** The corners a route may turn at: a body grown by `clearance`, minus any inside a block. */
function cornersOf(
  { body }: DetourObstacle,
  obstacles: readonly DetourObstacle[],
  clearance: number,
): Point[] {
  const left = body.x - clearance
  const right = body.x + body.w + clearance
  const top = body.y - clearance
  const bottom = body.y + body.h + clearance
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ].filter((corner) => !obstacles.some((o) => containsPoint(o.block, corner)))
}

/**
 * A* over the complete graph on `vertices` (the route's start at 0, its end
 * at 1), an edge existing where `visible` says the leg is clear. The straight
 * distance to the end is the heuristic: admissible because no leg is shorter
 * than the straight line it replaces and a corner only adds cost, so the
 * first time the end is taken off the frontier its path is the shortest.
 * Dense and array-based: the graph holds at most a few dozen vertices, where
 * a heap costs more than the scan it saves.
 */
function shortestThrough(
  vertices: readonly Point[],
  visible: (u: number, v: number) => boolean,
): Point[] | undefined {
  const goal = vertices[1] as Point
  const search: Search = {
    toGoal: vertices.map((p) => Math.hypot(goal.x - p.x, goal.y - p.y)),
    dist: vertices.map((_, i) => (i === 0 ? 0 : Number.POSITIVE_INFINITY)),
    prev: vertices.map(() => -1),
    done: vertices.map(() => false),
  }
  for (let u = nearestOpen(search); u !== -1; u = nearestOpen(search)) {
    if (u === 1) return pathTo(1, search.prev, vertices)
    search.done[u] = true
    relaxFrom(u, vertices, search, visible)
  }
  return undefined
}

/** A* state, one slot per vertex. */
interface Search {
  readonly toGoal: readonly number[]
  readonly dist: number[]
  readonly prev: number[]
  readonly done: boolean[]
}

/** The open vertex with the lowest estimated total, or -1 when none is reachable. */
function nearestOpen({ toGoal, dist, done }: Search): number {
  let best = -1
  let bestF = Number.POSITIVE_INFINITY
  for (let i = 0; i < dist.length; i++) {
    const f = (dist[i] as number) + (toGoal[i] as number)
    if (!done[i] && f < bestF) {
      best = i
      bestF = f
    }
  }
  return best
}

/** Shortens every open vertex reachable from `u` by a clear leg. */
function relaxFrom(
  u: number,
  vertices: readonly Point[],
  { dist, prev, done }: Search,
  visible: (u: number, v: number) => boolean,
): void {
  const from = vertices[u] as Point
  for (let v = 1; v < vertices.length; v++) {
    if (done[v]) continue
    const to = vertices[v] as Point
    const step = Math.hypot(to.x - from.x, to.y - from.y) + (v === 1 ? 0 : CORNER_COST_PX)
    const through = (dist[u] as number) + step
    if (through >= (dist[v] as number) || !visible(u, v)) continue
    dist[v] = through
    prev[v] = u
  }
}

function pathTo(at: number, prev: readonly number[], vertices: readonly Point[]): Point[] {
  const path: Point[] = []
  for (let v = at; v !== -1; v = prev[v] as number) path.push(vertices[v] as Point)
  return path.reverse()
}

/**
 * The part of `rect` a line may not enter: everything but its border, so a
 * leg arriving at an anchor on the border, or running along it, is clear.
 */
export function strictInterior(rect: Rect): Rect {
  const inset = Math.min(0.5, rect.w / 2, rect.h / 2)
  return { x: rect.x + inset, y: rect.y + inset, w: rect.w - 2 * inset, h: rect.h - 2 * inset }
}

/** Below this outward-to-tangential ratio (~14°), an approach reads as
 * running along the side rather than into it. */
const SIDEWAYS_RATIO = 0.25

/**
 * Whether a straight run from `anchor` toward `other` would leave through
 * the anchor side's outward half-plane. When it would not (the direction
 * grazes along the side or points back across the node — the shape an
 * occlusion-moved side produces), the edge needs a perpendicular stub
 * first, or it draws sliding along the node's own border and the arrowhead
 * meets the side edge-on.
 */
export function approachesSideways(anchor: Point, other: Point, side: EdgeSide): boolean {
  const vx = other.x - anchor.x
  const vy = other.y - anchor.y
  // Coincident anchors have no direction to graze along — the degenerate
  // zero-length path stays minimal rather than growing stubs.
  if (vx === 0 && vy === 0) return false
  const normal = outwardNormal(side)
  const outward = normal.x * vx + normal.y * vy
  const tangential = Math.abs(normal.x * vy - normal.y * vx)
  return outward <= tangential * SIDEWAYS_RATIO
}

/**
 * A detour's first or last leg can run nearly along its own side — a turn at
 * a corner beside the box sends it off at a glancing angle — so the line and
 * its arrowhead slide into the box edge-on. A stub squares that end, where
 * the leg on from the stub's tip is clear; otherwise the glancing leg stays,
 * since a line through something is worse than one meeting a box obliquely.
 */
export function squareEnds(
  path: Point[],
  {
    exit,
    entry,
    fromSide,
    toSide,
    clear,
  }: {
    exit: Point
    entry: Point
    fromSide: EdgeSide
    toSide: EdgeSide
    clear: (a: Point, b: Point) => boolean
  },
): Point[] {
  if (path.length === 2) return path
  const squared = [...path]
  const start = squared[0] as Point
  const next = squared[1] as Point
  if (approachesSideways(start, next, fromSide) && clear(exit, next)) squared.splice(1, 0, exit)
  const end = squared[squared.length - 1] as Point
  const before = squared[squared.length - 2] as Point
  if (approachesSideways(end, before, toSide) && clear(before, entry)) {
    squared.splice(squared.length - 1, 0, entry)
  }
  return squared
}
