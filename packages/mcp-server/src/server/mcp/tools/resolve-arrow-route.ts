// Pure helper that chooses arrow route points. It tries straight, then
// horizontal-first L, then vertical-first L, then Z detours. If every option
// collides, it falls back to the straight route without throwing.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface ResolveArrowRouteInput {
  start: Point
  end: Point
  obstacles?: Rect[]
}

export interface ResolveArrowRouteResult {
  // Relative points with start normalized to [0,0].
  points: [number, number][]
}

// Check whether two rectangles overlap by area; edge-touching does not count.
function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  )
}

// Turn an axis-aligned segment into a tiny rectangle for intersection testing.
function axisSegmentIntersectsRect(a: Point, b: Point, rect: Rect): boolean {
  const minX = Math.min(a.x, b.x)
  const maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxY = Math.max(a.y, b.y)
  // Expand zero-width/height segments slightly so edge contact is still detected.
  const segRect: Rect = {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 0.001),
    height: Math.max(maxY - minY, 0.001),
  }
  return rectsOverlap(segRect, rect)
}

// Segment-vs-rect intersection using Liang-Barsky clipping.
function segmentIntersectsRect(a: Point, b: Point, rect: Rect): boolean {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (dx === 0 && dy === 0) {
    // Degenerate case: treat the segment as a point.
    return a.x >= rect.x && a.x <= rect.x + rect.width && a.y >= rect.y && a.y <= rect.y + rect.height
  }
  let t0 = 0
  let t1 = 1
  const p = [-dx, dx, -dy, dy]
  const q = [a.x - rect.x, rect.x + rect.width - a.x, a.y - rect.y, rect.y + rect.height - a.y]
  for (let i = 0; i < 4; i++) {
    const pValue = p[i]!
    const qValue = q[i]!
    if (pValue === 0) {
      if (qValue < 0) return false
    } else {
      const t = qValue / pValue
      if (pValue < 0) {
        if (t > t1) return false
        if (t > t0) t0 = t
      } else {
        if (t < t0) return false
        if (t < t1) t1 = t
      }
    }
  }
  return t0 <= t1
}

// Return true when every adjacent segment in the route clears every obstacle.
function routeClear(absPoints: Point[], obstacles: Rect[]): boolean {
  for (let i = 0; i < absPoints.length - 1; i++) {
    const a = absPoints[i]
    const b = absPoints[i + 1]
    if (!a || !b) continue
    const axisAligned = a.x === b.x || a.y === b.y
    for (const obs of obstacles) {
      if (axisAligned) {
        if (axisSegmentIntersectsRect(a, b, obs)) return false
      } else {
        if (segmentIntersectsRect(a, b, obs)) return false
      }
    }
  }
  return true
}

// Convert absolute points to start-relative points.
function toRelative(start: Point, abs: Point[]): [number, number][] {
  return abs.map((p) => [p.x - start.x, p.y - start.y] as [number, number])
}

export function resolveArrowRoute(input: ResolveArrowRouteInput): ResolveArrowRouteResult {
  const { start, end } = input
  const obstacles = input.obstacles ?? []
  const dx = end.x - start.x
  const dy = end.y - start.y

  const straight: Point[] = [start, end]
  // Horizontal, vertical, and degenerate arrows do not benefit from L turns.
  if (dx === 0 || dy === 0) {
    return { points: toRelative(start, straight) }
  }

  // Straight route wins when it is already clear.
  if (obstacles.length === 0 || routeClear(straight, obstacles)) {
    return { points: toRelative(start, straight) }
  }

  // L1: horizontal first.
  const l1: Point[] = [start, { x: end.x, y: start.y }, end]
  if (routeClear(l1, obstacles)) {
    return { points: toRelative(start, l1) }
  }

  // L2: vertical first.
  const l2: Point[] = [start, { x: start.x, y: end.y }, end]
  if (routeClear(l2, obstacles)) {
    return { points: toRelative(start, l2) }
  }

  // Z detours route around the obstacle span on either axis.
  const DETOUR_MARGIN = 20
  const maxObX = Math.max(...obstacles.map((o) => o.x + o.width))
  const minObX = Math.min(...obstacles.map((o) => o.x))
  const maxObY = Math.max(...obstacles.map((o) => o.y + o.height))
  const minObY = Math.min(...obstacles.map((o) => o.y))
  const zCandidates: Point[][] = [
    // Z-right
    [start, { x: maxObX + DETOUR_MARGIN, y: start.y }, { x: maxObX + DETOUR_MARGIN, y: end.y }, end],
    // Z-left
    [start, { x: minObX - DETOUR_MARGIN, y: start.y }, { x: minObX - DETOUR_MARGIN, y: end.y }, end],
    // Z-below
    [start, { x: start.x, y: maxObY + DETOUR_MARGIN }, { x: end.x, y: maxObY + DETOUR_MARGIN }, end],
    // Z-above
    [start, { x: start.x, y: minObY - DETOUR_MARGIN }, { x: end.x, y: minObY - DETOUR_MARGIN }, end],
  ]
  for (const z of zCandidates) {
    if (routeClear(z, obstacles)) {
      return { points: toRelative(start, z) }
    }
  }

  // Fall back to the straight route so the arrow is always drawable.
  return { points: toRelative(start, straight) }
}
