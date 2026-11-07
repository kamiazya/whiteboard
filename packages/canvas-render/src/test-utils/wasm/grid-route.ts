import type { Point, Rect } from '../../layout/edges/edge-geometry.js'
import type { RoutingBudget } from '../../layout/edges/routing-budget.js'
import { requireWasm } from './glue.js'

/**
 * `routeOnGrid` answered by the Rust port through the wasm artifact, with the
 * TypeScript signature, so canvas-render-rust can run every suite that
 * reaches the grid router against Rust unchanged (ADR-0054 step 5's routing
 * spike, QR-21 layer 1). vitest.rust.config.ts aliases `./grid-route.js` to
 * this module; the routing scoreboards then pin the Rust router's numbers.
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
