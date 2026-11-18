import type { ResolvedEdgeNode } from '@kamiazya/whiteboard-scene'
import { hypot } from './det-math.js'

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
/**
 * A head is never narrower than this many line widths. Up to the line width
 * where the fixed 8-unit head reaches it (2.5), nothing changes — so every
 * light line draws byte-identically to how it always did — and past it the
 * head grows with the line instead of reading as a blunt end.
 */
const HEAD_WIDTHS_PER_LINE_WIDTH = 3.2

/** SVG's initial `stroke-width`: what an edge with no weight of its own draws at. */
const SVG_INITIAL_STROKE_WIDTH = 1

function lineWidth(edge: ResolvedEdgeNode): number {
  const width = edge.appearance?.strokeWidth
  return typeof width === 'number' && Number.isFinite(width) && width > 0
    ? width
    : SVG_INITIAL_STROKE_WIDTH
}

/** How much larger than the fixed head this edge's heads draw: 1 for a light line. */
function edgeArrowScale(edge: ResolvedEdgeNode): number {
  return Math.max(1, (lineWidth(edge) * HEAD_WIDTHS_PER_LINE_WIDTH) / (ARROW_HALF_WIDTH * 2))
}

export interface ArrowPolygon {
  /** Tip first, then the two wing corners — the SVG emission order. */
  readonly points: readonly { readonly x: number; readonly y: number }[]
}

function arrowAt(
  tip: { readonly x: number; readonly y: number },
  inward: { readonly x: number; readonly y: number },
  scale = 1,
): ArrowPolygon | null {
  const dx = tip.x - inward.x
  const dy = tip.y - inward.y
  const length = hypot(dx, dy)
  if (length < MIN_DIRECTION_LENGTH) return null
  const ux = dx / length
  const uy = dy / length
  const headLength = ARROW_LENGTH * scale
  const half = ARROW_HALF_WIDTH * scale
  const baseX = tip.x - ux * headLength
  const baseY = tip.y - uy * headLength
  // Perpendicular (-uy, ux); corner order is fixed for determinism.
  return {
    points: [
      tip,
      { x: baseX - uy * half, y: baseY + ux * half },
      { x: baseX + uy * half, y: baseY - ux * half },
    ],
  }
}

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
    const arrow = arrowAt(edge.path[0], edge.path[1], edgeArrowScale(edge))
    if (arrow) polygons.push(arrow)
  }
  if (edge.toEnd === 'arrow') {
    const tip = edge.path[edge.path.length - 1]
    const inward = edge.path[edge.path.length - 2]
    const arrow = arrowAt(tip, inward, edgeArrowScale(edge))
    if (arrow) polygons.push(arrow)
  }
  return polygons
}
