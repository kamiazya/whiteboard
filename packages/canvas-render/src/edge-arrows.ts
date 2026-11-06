import type { ResolvedEdgeNode } from '@kamiazya/whiteboard-scene'

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
export function edgeArrowScale(edge: ResolvedEdgeNode): number {
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
  const length = Math.hypot(dx, dy)
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
 * Marker-local arrowhead geometry: the same triangle `arrowAt` places in
 * canvas space, expressed in a marker viewport so the SVG backend can emit
 * ONE `<marker>` definition per (color, size) instead of a polygon per edge
 * end. Derived from the same constants, so the drawn ink is identical — the
 * browser's `orient="auto"` rotation reproduces `arrowAt`'s unit-vector
 * math (both take the direction of the path's terminal segment), which the
 * arrowhead pixel goldens pin. Points are tip first, per the emission-
 * order convention above. `refX`/`refY` place the tip on the path endpoint
 * `inset` units PAST the vertex the marker is attached to — exactly where
 * `arrowAt` puts it, once the backend has pulled the line's end back by
 * `inset` (see `edgeArrowInset`).
 */
export function arrowMarkerGeometry(direction: 'start' | 'end', scale: number, inset: number) {
  const length = ARROW_LENGTH * scale
  const half = ARROW_HALF_WIDTH * scale
  return direction === 'end'
    ? {
        width: length,
        height: half * 2,
        refX: length - inset,
        refY: half,
        points: [
          { x: length, y: half },
          { x: 0, y: 0 },
          { x: 0, y: half * 2 },
        ],
      }
    : // A start arrow points AGAINST the outgoing segment (its tip sits on the
      // first vertex), so the start marker's triangle points -x rather than
      // relying on `orient="auto-start-reverse"`, which resvg support is not
      // established for.
      {
        width: length,
        height: half * 2,
        refX: inset,
        refY: half,
        points: [
          { x: 0, y: half },
          { x: length, y: 0 },
          { x: length, y: half * 2 },
        ],
      }
}

/**
 * How far the line's own end must stop short of an arrow tip so its butt
 * end hides under the head. The head narrows to nothing at the tip, so a
 * line drawn all the way there shows its corners either side of it — which
 * on a heavy line blunts the tip or swallows the head. A light line keeps
 * its end (0): the overhang is sub-pixel, and its output stays as it was.
 * Also 0 when the terminal run is too short to shorten without losing its
 * direction, which only costs that the line's corners show.
 */
export function edgeArrowInset(edge: ResolvedEdgeNode, end: 'from' | 'to'): number {
  if (edgeArrowScale(edge) === 1 || edge.path.length < 2) return 0
  // Where the head is half a line wide: its half-width grows by
  // HALF_WIDTH per LENGTH back from the tip.
  const inset = ((lineWidth(edge) / 2) * ARROW_LENGTH) / ARROW_HALF_WIDTH
  const tip = end === 'to' ? edge.path[edge.path.length - 1] : edge.path[0]
  const inward = end === 'to' ? edge.path[edge.path.length - 2] : edge.path[1]
  const run = Math.hypot(tip.x - inward.x, tip.y - inward.y)
  return run > inset + MIN_DIRECTION_LENGTH ? inset : 0
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
