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
