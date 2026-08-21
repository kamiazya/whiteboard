import type { ResolvedEdgeNode } from './scene-graph.js'

/**
 * Arrowhead geometry shared by the SVG backend (which draws the triangles)
 * and `sceneBounds` (which must include their wings so a derived viewBox
 * never clips them). One producer keeps the two in agreement.
 *
 * Sizes are canvas units — arrowheads scale with the content under
 * pan/zoom exactly like stroke geometry does.
 */
const ARROW_LENGTH = 10
const ARROW_HALF_WIDTH = 4
/** Below this segment length there is no usable direction — skip the arrow. */
const MIN_DIRECTION_LENGTH = 1e-6

export interface ArrowPolygon {
  /** Tip first, then the two wing corners — the SVG emission order. */
  readonly points: readonly { readonly x: number; readonly y: number }[]
}

function arrowAt(
  tip: { readonly x: number; readonly y: number },
  inward: { readonly x: number; readonly y: number },
): ArrowPolygon | null {
  const dx = tip.x - inward.x
  const dy = tip.y - inward.y
  const length = Math.hypot(dx, dy)
  if (length < MIN_DIRECTION_LENGTH) return null
  const ux = dx / length
  const uy = dy / length
  const baseX = tip.x - ux * ARROW_LENGTH
  const baseY = tip.y - uy * ARROW_LENGTH
  // Perpendicular (-uy, ux); corner order is fixed for determinism.
  return {
    points: [
      tip,
      { x: baseX - uy * ARROW_HALF_WIDTH, y: baseY + ux * ARROW_HALF_WIDTH },
      { x: baseX + uy * ARROW_HALF_WIDTH, y: baseY - ux * ARROW_HALF_WIDTH },
    ],
  }
}

/**
 * Marker-local arrowhead geometry: the same triangle `arrowAt` places in
 * canvas space, expressed in a marker viewport so the SVG backend can emit
 * ONE `<marker>` definition per color instead of a polygon per edge end.
 * Derived from the same constants, so the drawn ink is identical — the
 * browser's `orient="auto"` rotation reproduces `arrowAt`'s unit-vector
 * math (both take the direction of the path's terminal segment), which the
 * arrowhead pixel goldens pin. Points are tip first, per the emission-
 * order convention above. `refX`/`refY` place the tip ON the path
 * endpoint, exactly where `arrowAt` puts it.
 */
export const ARROW_MARKER = {
  width: ARROW_LENGTH,
  height: ARROW_HALF_WIDTH * 2,
  end: {
    refX: ARROW_LENGTH,
    refY: ARROW_HALF_WIDTH,
    points: [
      { x: ARROW_LENGTH, y: ARROW_HALF_WIDTH },
      { x: 0, y: 0 },
      { x: 0, y: ARROW_HALF_WIDTH * 2 },
    ],
  },
  // A start arrow points AGAINST the outgoing segment (its tip sits on the
  // first vertex), so the start marker's triangle points -x rather than
  // relying on `orient="auto-start-reverse"`, which resvg support is not
  // established for.
  start: {
    refX: 0,
    refY: ARROW_HALF_WIDTH,
    points: [
      { x: 0, y: ARROW_HALF_WIDTH },
      { x: ARROW_LENGTH, y: 0 },
      { x: ARROW_LENGTH, y: ARROW_HALF_WIDTH * 2 },
    ],
  },
} as const

/**
 * Which ends of this edge get an arrowhead — the SAME rule that decides
 * whether `edgeArrowPolygons` yields a polygon for that end. The backend
 * must consult this (not `fromEnd`/`toEnd` alone) before attaching a
 * marker: an end with no usable direction draws nothing as a polygon,
 * while a marker with `orient="auto"` on a degenerate segment would paint
 * an arrow at angle 0.
 */
export function edgeArrowEnds(edge: ResolvedEdgeNode): { from: boolean; to: boolean } {
  if (edge.path.length < 2) return { from: false, to: false }
  const from = edge.fromEnd === 'arrow' && arrowAt(edge.path[0], edge.path[1]) !== null
  const tip = edge.path[edge.path.length - 1]
  const inward = edge.path[edge.path.length - 2]
  const to = edge.toEnd === 'arrow' && arrowAt(tip, inward) !== null
  return { from, to }
}

/**
 * The arrowhead polygons of an edge, source arrow first. Total: a
 * degenerate path (fewer than two points, or no finite direction at an
 * end) simply yields no polygon for that end.
 */
export function edgeArrowPolygons(edge: ResolvedEdgeNode): readonly ArrowPolygon[] {
  if (edge.path.length < 2) return []
  const polygons: ArrowPolygon[] = []
  if (edge.fromEnd === 'arrow') {
    const arrow = arrowAt(edge.path[0], edge.path[1])
    if (arrow) polygons.push(arrow)
  }
  if (edge.toEnd === 'arrow') {
    const tip = edge.path[edge.path.length - 1]
    const inward = edge.path[edge.path.length - 2]
    const arrow = arrowAt(tip, inward)
    if (arrow) polygons.push(arrow)
  }
  return polygons
}
