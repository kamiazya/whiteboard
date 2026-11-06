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
import {
  arrowMarkerGeometry,
  edgeArrowEnds,
  edgeArrowInset,
  edgeArrowScale,
} from '../edge-arrows.js'
import { hopEndpoints, jumpsWithinSpan } from '../layout/edges/edge-flatten.js'
import { EDGE_JUMP_RADIUS_PX } from '../layout/edges/edge-jumps.js'
import { roundedEdgeCorners } from '../layout/edges/edge-rounding.js'
import { formatCoord } from './format.js'
import { appearanceAttrs, idToken, PRESENTATION, pointsAttr } from './paint.js'
import { edgeGlowExtent, glowOf, renderSketchEdge } from './shapes.js'
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

function arrowMarkerDef(
  direction: 'start' | 'end',
  fill: string,
  scale: number,
  inset: number,
): SvgDef {
  const geometry = arrowMarkerGeometry(direction, scale, inset)
  // A fixed-size head keeps its historical id, so a light line's output
  // is unchanged; a scaled one adds its size and reference to the id,
  // which is what tells two definitions in one colour apart.
  const size =
    scale === 1 && inset === 0 ? '' : `-${idToken(`${formatCoord(scale)}-${formatCoord(inset)}`)}`
  const id = `wb-arrow-${direction}-${idToken(fill)}${size}`
  return {
    id,
    node: el(
      'marker',
      {
        id,
        markerWidth: geometry.width,
        markerHeight: geometry.height,
        refX: geometry.refX,
        refY: geometry.refY,
        markerUnits: 'userSpaceOnUse',
        orient: 'auto',
      },
      [el('polygon', { points: pointsAttr(geometry.points), fill })],
    ),
  }
}

/**
 * The path with each arrowed end moved back along its terminal run, so a
 * heavy line's butt end sits under its head rather than poking past the
 * tip. The insets are 0 for a light line and for a run too short to
 * shorten (`edgeArrowInset`), which returns the path as it was.
 */
function pulledBack(
  path: readonly EdgePoint[],
  fromInset: number,
  toInset: number,
): readonly EdgePoint[] {
  if (fromInset === 0 && toInset === 0) return path
  const toward = (from: EdgePoint, to: EdgePoint, by: number): EdgePoint => {
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    return {
      x: from.x + ((to.x - from.x) / length) * by,
      y: from.y + ((to.y - from.y) / length) * by,
    }
  }
  const last = path.length - 1
  return path.map((point, index) =>
    index === 0 && fromInset > 0
      ? toward(point, path[1] as EdgePoint, fromInset)
      : index === last && toInset > 0
        ? toward(point, path[last - 1] as EdgePoint, toInset)
        : point,
  )
}

/**
 * Arrowheads are shared <marker> definitions in the edge's stroke color and
 * head size, referenced per end — one definition per (direction, color,
 * size) instead of a polygon per edge end. Marker geometry derives from the
 * same constants as `edgeArrowPolygons` (edge-arrows.ts), which sceneBounds
 * keeps reading for the wings' reach; the arrowhead pixel goldens pin that
 * the two stay the same ink. Which ends get one is `edgeArrowEnds` — the
 * polygon renderer's own skip rule — because a marker on a direction-less
 * end would paint at angle 0 where the polygon drew nothing. Answers the
 * path to draw too, since a heavy line's arrowed ends are pulled back
 * under their heads.
 */
function arrowheads(node: ResolvedEdgeNode): {
  readonly startDef: SvgDef | undefined
  readonly endDef: SvgDef | undefined
  readonly path: readonly EdgePoint[]
} {
  const stroke = node.appearance?.stroke
  // No stroke means the polyline itself is invisible (SVG's default
  // stroke is none) — the arrow must match it, not fall back to the
  // marker content's default black fill and float detached.
  const arrowFill = typeof stroke === 'string' && stroke.length > 0 ? stroke : 'none'
  const ends = edgeArrowEnds(node)
  const scale = edgeArrowScale(node)
  const fromInset = ends.from ? edgeArrowInset(node, 'from') : 0
  const toInset = ends.to ? edgeArrowInset(node, 'to') : 0
  return {
    startDef: ends.from ? arrowMarkerDef('start', arrowFill, scale, fromInset) : undefined,
    endDef: ends.to ? arrowMarkerDef('end', arrowFill, scale, toInset) : undefined,
    path: pulledBack(node.path, fromInset, toInset),
  }
}

export function renderEdge(node: ResolvedEdgeNode): SvgChild {
  if (node.ink?.style === 'sketch') return renderSketchEdge(node, node.ink)
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
  const { startDef, endDef, path } = arrowheads(node)
  const markers = {
    'marker-start': startDef === undefined ? undefined : `url(#${startDef.id})`,
    'marker-end': endDef === undefined ? undefined : `url(#${endDef.id})`,
  }
  const polyline =
    node.rounded === true
      ? el('path', {
          d: roundedPathData(path, jumps),
          fill: 'none',
          ...appearance,
          ...markers,
          role: PRESENTATION,
        })
      : jumps.length > 0
        ? el('path', {
            d: jumpedPathData(path, jumps),
            fill: 'none',
            ...appearance,
            ...markers,
            role: PRESENTATION,
          })
        : el('polyline', {
            points: pointsAttr(path),
            fill: 'none',
            ...appearance,
            ...markers,
            role: PRESENTATION,
          })
  const glow = glowOf(node.appearance, edgeGlowExtent(node))
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
