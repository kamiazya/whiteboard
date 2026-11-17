import type { RoutingBudget } from '../../edge-routing.js'
import type { Point, Rect } from '../../generated/geometry.zod.js'
import { requireWasm } from './glue.js'

/**
 * `routeOnGrid` answered by the Rust port through the wasm artifact's
 * oracle-surface export (`edge_route_on_grid`), with the signature the
 * deleted TypeScript grid router had, so canvas-render-rust's grid examples,
 * its optimality property and its scoreboard pin the Rust router's numbers
 * (ADR-0054 step 5's routing spike, QR-21 layer 1; the TypeScript went in
 * step 7, S18h3b). Test-only: no shipped artifact carries the export.
 */
export function routeOnGrid(
  start: Point,
  end: Point,
  obstacles: readonly Rect[],
  clearance: number,
  budget?: Pick<RoutingBudget, 'grid'>,
): Point[] | undefined {
  const input = new Float64Array(6 + obstacles.length * 4)
  input.set([start.x, start.y, end.x, end.y, clearance, budget?.grid ?? Number.POSITIVE_INFINITY])
  obstacles.forEach((r, i) => {
    input.set([r.x, r.y, r.w, r.h], 6 + i * 4)
  })
  const out = requireWasm().edge_route_on_grid(input)
  if (budget !== undefined) budget.grid -= out[0] ?? 0
  if (out.length < 3) return undefined
  const path: Point[] = []
  for (let i = 1; i + 1 < out.length; i += 2)
    path.push({ x: out[i] as number, y: out[i + 1] as number })
  return path
}
