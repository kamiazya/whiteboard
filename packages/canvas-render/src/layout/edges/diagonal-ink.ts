type Point = { readonly x: number; readonly y: number }
type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/**
 * Length of a path's NON-axis-aligned segments strictly inside `rects` —
 * the straight style's routes are diagonals, and the ink terms in
 * `edge-rules.ts` read axis-aligned segments only by design, so a diagonal
 * back through an edge's own box cost the search nothing while the drawing
 * showed 63px of it. Open clipping (Liang–Barsky): a chord strictly inside
 * a rect counts, a segment riding a border or touching a corner does not.
 * Raw pixels; the caller quantizes into its cost space.
 */
export function diagonalInkThrough(path: readonly Point[], rects: readonly Rect[]): number {
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    const dx = b.x - a.x
    const dy = b.y - a.y
    if (dx === 0 || dy === 0) continue
    for (const r of rects) {
      let t0 = 0
      let t1 = 1
      for (const [p, q] of [
        [-dx, a.x - r.x],
        [dx, r.x + r.w - a.x],
        [-dy, a.y - r.y],
        [dy, r.y + r.h - a.y],
      ] as const) {
        const t = q / p
        if (p < 0) t0 = Math.max(t0, t)
        else t1 = Math.min(t1, t)
      }
      if (t1 > t0) total += (t1 - t0) * Math.hypot(dx, dy)
    }
  }
  return total
}
