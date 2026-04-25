// Pure helper that snaps arrow endpoints to a box edge intersection.
// It casts a ray from the box center toward the opposite endpoint and returns
// the point where that ray intersects the rectangle boundary. If no box is
// provided or the direction vector is zero, the original point is preserved.

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface SnapArrowInput {
  start: Point
  end: Point
  startBox?: Rect
  endBox?: Rect
}

export interface SnapArrowResult {
  start: Point
  end: Point
}

// Return the rectangle-boundary intersection for a ray that starts at the box
// center and points toward target (the opposite endpoint). If the direction
// vector is zero, return the fallback point unchanged.
function snapPointToBoxEdge(box: Rect, target: Point, fallback: Point): Point {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const dx = target.x - cx
  const dy = target.y - cy
  if (dx === 0 && dy === 0) return fallback
  const halfW = box.width / 2
  const halfH = box.height / 2
  // Intersect the positive ray with the rectangle edges using
  // t = halfW/|dx| and halfH/|dy|. The first hit uses the smaller t.
  const tx = dx === 0 ? Infinity : halfW / Math.abs(dx)
  const ty = dy === 0 ? Infinity : halfH / Math.abs(dy)
  const t = Math.min(tx, ty)
  return {
    x: cx + dx * t,
    y: cy + dy * t,
  }
}

export function snapArrowEndpoints(input: SnapArrowInput): SnapArrowResult {
  const start = input.startBox
    ? snapPointToBoxEdge(input.startBox, input.end, input.start)
    : input.start
  const end = input.endBox
    ? snapPointToBoxEdge(input.endBox, input.start, input.end)
    : input.end
  return { start, end }
}
