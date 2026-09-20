/**
 * How an EDGE is drawn: its path data (jumped, rounded), its arrowheads as
 * shared marker definitions, and the assembly of the two.
 *
 * Its own module rather than four more functions in `backend.ts`, which sat
 * three lines under the 800-line budget while holding nineteen node kinds.
 * This is the one kind whose drawing is a subject of its own — what it
 * paints already has three modules of its own (`edge-arrows`, `edge-jumps`,
 * `edge-rounding`) — and it was a third of `renderNode` by itself.
 */

import type { ResolvedEdgeNode } from '@kamiazya/whiteboard-scene'
import { ARROW_MARKER, edgeArrowEnds } from '../edge-arrows.js'
import { hopEndpoints, jumpsWithinSpan } from '../layout/edges/edge-flatten.js'
import { EDGE_JUMP_RADIUS_PX } from '../layout/edges/edge-jumps.js'
import { roundedEdgeCorners } from '../layout/edges/edge-rounding.js'
import { formatCoord } from './format.js'
import { appearanceAttrs, idToken, PRESENTATION, pointsAttr } from './paint.js'
import { glowOf, type ResolveTables, renderSketchEdge } from './shapes.js'
import { el, type SvgChild, type SvgDef, withDefs } from './vnode.js'

type EdgePoint = { readonly x: number; readonly y: number }

type EdgeJump = { readonly segment: number; readonly x: number; readonly y: number }

/**
 * Path commands for one straight run from `from` to `to`, hopping over each
 * jump point with a half-circle arc. Sweep 1 bulges to the LEFT of travel
 * in SVG's y-down coordinates (up, for a rightward run) — drawio-style
 * "over", and the side `flattenDrawnEdgePath` samples for hit-testing and
 * the selection highlight. Jumps arrive ordered along the run.
 */
function lineWithJumps(
  from: EdgePoint,
  to: EdgePoint,
  jumps: readonly EdgeJump[],
): readonly string[] {
  const parts: string[] = []
  for (const jump of jumps) {
    const hop = hopEndpoints(from, to, jump)
    if (hop === undefined) continue
    parts.push(`L ${formatCoord(hop.entry.x)} ${formatCoord(hop.entry.y)}`)
    parts.push(
      `A ${EDGE_JUMP_RADIUS_PX} ${EDGE_JUMP_RADIUS_PX} 0 0 1 ${formatCoord(hop.exit.x)} ${formatCoord(hop.exit.y)}`,
    )
  }
  parts.push(`L ${formatCoord(to.x)} ${formatCoord(to.y)}`)
  return parts
}

/** The polyline as a path `d`, hopping over each jump on its segment. */
function jumpedPathData(path: readonly EdgePoint[], jumps: readonly EdgeJump[]): string {
  const first = path[0]
  if (first === undefined) return ''
  const parts = [`M ${formatCoord(first.x)} ${formatCoord(first.y)}`]
  for (let seg = 0; seg < path.length - 1; seg += 1) {
    parts.push(
      ...lineWithJumps(
        path[seg] as EdgePoint,
        path[seg + 1] as EdgePoint,
        jumps.filter((jump) => jump.segment === seg),
      ),
    )
  }
  return parts.join(' ')
}

/**
 * The same polyline with its corners rounded off, per the shared
 * `roundedEdgeCorners` decomposition (see layout/edges/edge-rounding.ts — the
 * editor's hit-testing flattens the SAME corners, which is what keeps a tap
 * landing on the ink). Degenerate inputs fall back to the straight reading
 * rather than emitting a malformed `d`, matching this package's never-throw
 * rule.
 */
function roundedPathData(path: readonly EdgePoint[], jumps: readonly EdgeJump[] = []): string {
  const first = path[0]
  const last = path.at(-1)
  if (first === undefined || last === undefined) return ''
  if (path.length < 3) {
    return [
      `M ${formatCoord(first.x)} ${formatCoord(first.y)}`,
      ...lineWithJumps(first, last, jumpsWithinSpan(jumps, 0, first, last)),
    ].join(' ')
  }

  const parts = [`M ${formatCoord(first.x)} ${formatCoord(first.y)}`]
  let current = first
  const corners = roundedEdgeCorners(path)
  for (const [index, { enter, control, leave }] of corners.entries()) {
    parts.push(...lineWithJumps(current, enter, jumpsWithinSpan(jumps, index, current, enter)))
    parts.push(
      `Q ${formatCoord(control.x)} ${formatCoord(control.y)} ${formatCoord(leave.x)} ${formatCoord(leave.y)}`,
    )
    current = leave
  }
  parts.push(...lineWithJumps(current, last, jumpsWithinSpan(jumps, corners.length, current, last)))
  return parts.join(' ')
}

function arrowMarkerDef(direction: 'start' | 'end', fill: string): SvgDef {
  const geometry = ARROW_MARKER[direction]
  const id = `wb-arrow-${direction}-${idToken(fill)}`
  return {
    id,
    node: el(
      'marker',
      {
        id,
        markerWidth: ARROW_MARKER.width,
        markerHeight: ARROW_MARKER.height,
        refX: geometry.refX,
        refY: geometry.refY,
        markerUnits: 'userSpaceOnUse',
        orient: 'auto',
      },
      [el('polygon', { points: pointsAttr(geometry.points), fill })],
    ),
  }
}

export function renderEdge(node: ResolvedEdgeNode, tables?: ResolveTables): SvgChild {
  if (node.ink?.style === 'sketch') return renderSketchEdge(node, node.ink, tables)
  const appearance = appearanceAttrs(node.appearance)
  // `fill="none"` is not decoration. SVG's initial fill is black and a
  // <polyline> fills the region its points enclose, so a bent edge would
  // paint a solid wedge across its own corner in whatever fill the
  // surrounding document inherits — invisible while every path had two
  // points, glaring the moment routing started bending them. A <path>
  // needs it for exactly the same reason. It is declared before the
  // appearance spread, matching the string backend's emission order (an
  // edge appearance never carries a fill of its own).
  const jumps = node.jumps ?? []
  // Arrowheads are shared <marker> definitions in the edge's stroke
  // color, referenced per end — one definition per (direction, color)
  // instead of a polygon per edge end. Marker geometry derives from the
  // same constants as `edgeArrowPolygons` (edge-arrows.ts), which
  // sceneBounds keeps reading for the wings' reach; the arrowhead pixel
  // goldens pin that the two stay the same ink. Which ends get one is
  // `edgeArrowEnds` — the polygon renderer's own skip rule — because a
  // marker on a direction-less end would paint at angle 0 where the
  // polygon drew nothing.
  const stroke = node.appearance?.stroke
  // No stroke means the polyline itself is invisible (SVG's default
  // stroke is none) — the arrow must match it, not fall back to the
  // marker content's default black fill and float detached.
  const arrowFill = typeof stroke === 'string' && stroke.length > 0 ? stroke : 'none'
  const ends = edgeArrowEnds(node)
  const startDef = ends.from ? arrowMarkerDef('start', arrowFill) : undefined
  const endDef = ends.to ? arrowMarkerDef('end', arrowFill) : undefined
  const markers = {
    'marker-start': startDef === undefined ? undefined : `url(#${startDef.id})`,
    'marker-end': endDef === undefined ? undefined : `url(#${endDef.id})`,
  }
  const polyline =
    node.rounded === true
      ? el('path', {
          d: roundedPathData(node.path, jumps),
          fill: 'none',
          ...appearance,
          ...markers,
          role: PRESENTATION,
        })
      : jumps.length > 0
        ? el('path', {
            d: jumpedPathData(node.path, jumps),
            fill: 'none',
            ...appearance,
            ...markers,
            role: PRESENTATION,
          })
        : el('polyline', {
            points: pointsAttr(node.path),
            fill: 'none',
            ...appearance,
            ...markers,
            role: PRESENTATION,
          })
  const glow = glowOf(node.appearance, tables)
  const defs = [
    ...(startDef === undefined ? [] : [startDef]),
    ...(endDef === undefined ? [] : [endDef]),
    ...glow.defs,
  ]
  const line =
    glow.filter === undefined
      ? polyline
      : { ...polyline, attrs: { ...polyline.attrs, filter: glow.filter } }
  return defs.length > 0 ? withDefs(line, defs) : line
}
