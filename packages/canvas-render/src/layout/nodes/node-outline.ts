/**
 * The ONE producer of non-rect node silhouettes, per this package's "one
 * producer per geometry, or a parity test" rule: the SVG backend draws the
 * outline this module decomposes, and hit-testing / edge anchoring answer
 * against the SAME decomposition, so what is painted and what responds to
 * the pointer cannot drift (the curved-edge highlight/hit mismatch class).
 *
 * Outlines derive from the node's bbox and a KIND — never stored path
 * coordinates — so `translateScene` needs no knowledge of them (the bbox
 * moves, the outline follows) and `scaleScene` scales them implicitly.
 * Everything here is pure and total: a bbox with a non-finite field yields
 * `null`/`false` instead of throwing, per the package's never-throw rule.
 */

import type { BoundingBox } from '../../scene-graph.js'

/**
 * A silhouette a plugin registers, under a NAMESPACED id.
 *
 * `outline` is the whole contract for painting, hit-testing and edge
 * anchoring, because `outlineContains` switches on the returned VALUE's kind
 * and `outlineEntryPoint` bisects against that — one implementation serves
 * every shape, and nothing a contributor supplies can make the drawn and the
 * hit geometry disagree.
 *
 * `contentBox` is the exception, and is optional for a reason: it is a
 * per-shape judgement (how much of the box may text use) that no formula
 * derives from a polygon. A shape that omits it gets the bbox — content may
 * then cross the silhouette, exactly the degradation an unknown id gets.
 *
 * ponytail: a returned polygon must be CONVEX. `outlineContains` answers
 * through `convexPolygonContains` and `outlineEntryPoint` bisects assuming
 * the outline is convex along the probed ray — true of every built-in, and
 * now a contract a contributor can break. A concave shape still DRAWS
 * correctly; what degrades is hit-testing and where an edge terminates,
 * both falling back to the convex hull. Lifting it means a general
 * point-in-polygon test plus a ray intersection that does not assume a
 * single crossing, and is worth doing when a contributed concave shape is
 * real rather than a demo.
 */
export interface ShapeContribution {
  readonly outline: (box: BoundingBox) => NodeOutline | null
  readonly contentBox?: (box: BoundingBox) => BoundingBox
}

/**
 * Shapes by namespaced id (`visual.diamond`). The namespace is COMPOSED by
 * the caller from the declaring facet's key, never read out of a payload —
 * so a document cannot name another plugin's geometry.
 */
export type ShapeTable = Readonly<Record<string, ShapeContribution>>

/**
 * A caller's table is MERGED OVER the built-ins, never a replacement — an id
 * it does not carry still resolves, and an id it does overrides. Done as a
 * fallback lookup rather than an object spread because this runs per node
 * per layout, and because it keeps the merge correct for a direct caller
 * (hit-testing, a test) that never went through the layout entry point.
 */
const lookup = (shapes: ShapeTable, shapeId: string): ShapeContribution | undefined =>
  shapes[shapeId] ?? BUILT_IN_SHAPES[shapeId]

export type NodeOutline =
  | {
      readonly kind: 'ellipse'
      readonly cx: number
      readonly cy: number
      readonly rx: number
      readonly ry: number
    }
  | {
      readonly kind: 'polygon'
      readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>
    }
  | {
      readonly kind: 'cylinder'
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
      /** Lid ellipse's vertical radius: a tenth of the width, capped at a
       * quarter of the height so short nodes keep a visible body. */
      readonly ry: number
    }

const isFiniteBox = (box: BoundingBox): boolean =>
  Number.isFinite(box.x) &&
  Number.isFinite(box.y) &&
  Number.isFinite(box.w) &&
  Number.isFinite(box.h)

/**
 * The shapes the bundled `visual` plugin declares. They live here only until
 * the plugin owns them; nothing about them is privileged, and a third-party
 * table is merged over this one by exactly the same rule.
 */
export const BUILT_IN_SHAPES: ShapeTable = {
  'visual.ellipse': {
    outline: (box) => ({
      kind: 'ellipse',
      cx: box.x + box.w / 2,
      cy: box.y + box.h / 2,
      rx: box.w / 2,
      ry: box.h / 2,
    }),
    // 0.15 rather than the exact (1 - 1/√2)/2 ≈ 0.1464: the exact value puts
    // corners ON the rim, where float error flips containment, and content
    // should not kiss the stroke anyway.
    contentBox: (box) => {
      const dx = box.w * 0.15
      const dy = box.h * 0.15
      return { x: box.x + dx, y: box.y + dy, w: box.w - 2 * dx, h: box.h - 2 * dy }
    },
  },
  'visual.diamond': {
    // Edge-midpoint polygon, clockwise from the top vertex — the corner
    // order is fixed for deterministic serialization.
    outline: (box) => {
      const cx = box.x + box.w / 2
      const cy = box.y + box.h / 2
      return {
        kind: 'polygon',
        points: [
          { x: cx, y: box.y },
          { x: box.x + box.w, y: cy },
          { x: cx, y: box.y + box.h },
          { x: box.x, y: cy },
        ],
      }
    },
    contentBox: (box) => ({
      x: box.x + box.w / 4,
      y: box.y + box.h / 4,
      w: box.w / 2,
      h: box.h / 2,
    }),
  },
  'visual.hexagon': {
    // Pointy-left-right six-gon, clockwise from the top-left corner. The
    // corner inset is a quarter of the width, capped at half the height so
    // degenerate proportions stay a valid convex polygon.
    outline: (box) => {
      const cy = box.y + box.h / 2
      const inset = Math.min(box.w / 4, box.h / 2)
      return {
        kind: 'polygon',
        points: [
          { x: box.x + inset, y: box.y },
          { x: box.x + box.w - inset, y: box.y },
          { x: box.x + box.w, y: cy },
          { x: box.x + box.w - inset, y: box.y + box.h },
          { x: box.x + inset, y: box.y + box.h },
          { x: box.x, y: cy },
        ],
      }
    },
    contentBox: (box) => insetHorizontally(box),
  },
  'visual.parallelogram': {
    // Right-leaning skew, clockwise from the top-left vertex; same capped
    // proportion as the hexagon inset.
    outline: (box) => {
      const skew = Math.min(box.w / 4, box.h / 2)
      return {
        kind: 'polygon',
        points: [
          { x: box.x + skew, y: box.y },
          { x: box.x + box.w, y: box.y },
          { x: box.x + box.w - skew, y: box.y + box.h },
          { x: box.x, y: box.y + box.h },
        ],
      }
    },
    contentBox: (box) => insetHorizontally(box),
  },
  'visual.cylinder': {
    outline: (box) => ({
      kind: 'cylinder',
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      ry: Math.min(box.w * 0.1, box.h / 4),
    }),
    // Gives up the lid (its drawn front rim dips to 2·ry) and the bottom
    // bulge.
    contentBox: (box) => {
      const ry = Math.min(box.w * 0.1, box.h / 4)
      return { x: box.x, y: box.y + 2 * ry, w: box.w, h: box.h - 3 * ry }
    },
  },
}

/** Hexagon and parallelogram give up only their slanted horizontal margins. */
function insetHorizontally(box: BoundingBox): BoundingBox {
  const inset = Math.min(box.w / 4, box.h / 2)
  return { x: box.x + inset, y: box.y, w: box.w - 2 * inset, h: box.h }
}

/**
 * An unknown id degrades to `null` — a plain rect — like any other malformed
 * input, because the VALUE arrives from a stored facet payload and a document
 * naming a shape this build does not carry is ordinary, not exceptional.
 */
export function nodeOutline(
  shapeId: string,
  box: BoundingBox,
  shapes: ShapeTable = BUILT_IN_SHAPES,
): NodeOutline | null {
  if (!isFiniteBox(box)) return null
  return lookup(shapes, shapeId)?.outline(box) ?? null
}

/**
 * The axis-aligned box inscribed in the outline — where a node's CONTENT can
 * lay out without crossing the silhouette. A rect (no outline) is its own
 * content box, and an unsupported runtime value degrades the same way, per
 * `nodeOutline`'s null contract.
 *
 * Ellipse and diamond take the maximal inscribed rect of the box's own
 * aspect; hexagon and parallelogram give up only their slanted horizontal
 * margins; the cylinder gives up the lid (its drawn front rim dips to 2·ry)
 * and the bottom bulge. Every corner returned here satisfies
 * `outlineContains` — the geometry test pins that per kind.
 */
export function outlineContentBox(
  shapeId: string | undefined,
  box: BoundingBox,
  shapes: ShapeTable = BUILT_IN_SHAPES,
): BoundingBox {
  if (shapeId === undefined || !isFiniteBox(box)) return box
  return lookup(shapes, shapeId)?.contentBox?.(box) ?? box
}

/**
 * Point containment against the outline (boundary counts as inside) — the
 * hit-test half of the producer. Total: any non-finite input answers false.
 */
export function outlineContains(
  shapeId: string,
  box: BoundingBox,
  point: { readonly x: number; readonly y: number },
  shapes: ShapeTable = BUILT_IN_SHAPES,
): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
  const outline = nodeOutline(shapeId, box, shapes)
  if (outline === null) return false
  switch (outline.kind) {
    case 'ellipse': {
      if (outline.rx <= 0 || outline.ry <= 0) {
        return point.x === outline.cx && point.y === outline.cy
      }
      const nx = (point.x - outline.cx) / outline.rx
      const ny = (point.y - outline.cy) / outline.ry
      return nx * nx + ny * ny <= 1
    }
    case 'polygon':
      return convexPolygonContains(outline.points, point)
    case 'cylinder': {
      const { x, y, w, h, ry } = outline
      if (point.x < x || point.x > x + w) return false
      if (point.y >= y + ry && point.y <= y + h - ry) return true
      const rx = w / 2
      if (rx <= 0 || ry <= 0) return point.y >= y && point.y <= y + h
      // Above the body: the upper half of the top-cap ellipse; below: the
      // lower half of the bottom bulge. Same quadratic as the ellipse case.
      const capCy = point.y < y + ry ? y + ry : y + h - ry
      const nx = (point.x - (x + rx)) / rx
      const ny = (point.y - capCy) / ry
      return nx * nx + ny * ny <= 1
    }
  }
}

/** Search resolution for the boundary crossing: 2^-32 of the segment
 * length is far below a hundredth of a pixel at canvas scale. */
const ENTRY_SEARCH_ITERATIONS = 32

/**
 * Where the extension of `from -> to` first meets the outline at or beyond
 * `to` — the edge-anchoring half of the producer. An edge routed against
 * the bbox terminates ON the bbox border, which for every inscribed
 * outline is OUTSIDE the silhouette except at tangent points; this pulls
 * that terminal inward along its approach direction so an arrowhead
 * touches the rim it appears to point at.
 *
 * Derived from `outlineContains` by bisection rather than per-kind
 * intersection math, deliberately: every outline is convex along the
 * probed ray, one implementation serves all kinds, and the boundary the
 * anchor lands on is BY CONSTRUCTION the same one hit-testing answers
 * for — nothing to drift, no parity test needed. Total: if the probed
 * span never enters the outline (or any input is non-finite), `to` is
 * returned unchanged.
 */
export function outlineEntryPoint(
  shapeId: string,
  box: BoundingBox,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  shapes: ShapeTable = BUILT_IN_SHAPES,
): { readonly x: number; readonly y: number } {
  if (!isFiniteBox(box)) return to
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) return to
  if (outlineContains(shapeId, box, to, shapes)) return to
  // Probe from `to` toward the box center — the deepest point the
  // continuation of the approach can meaningfully reach inside a convex
  // outline that contains the center.
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 }
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  // With no usable approach direction, fall back to probing straight at
  // the center so a degenerate edge still lands on the boundary.
  const dirX = length > 0 ? dx / length : center.x - to.x
  const dirY = length > 0 ? dy / length : center.y - to.y
  // The farthest useful probe: past the center the ray is leaving again.
  const span = Math.hypot(center.x - to.x, center.y - to.y)
  const dirLength = Math.hypot(dirX, dirY)
  if (!(dirLength > 0) || !Number.isFinite(span)) return to
  const far = { x: to.x + (dirX / dirLength) * span, y: to.y + (dirY / dirLength) * span }
  if (!outlineContains(shapeId, box, far, shapes)) return to
  let lo = 0 // outside
  let hi = 1 // inside
  for (let i = 0; i < ENTRY_SEARCH_ITERATIONS; i++) {
    const mid = (lo + hi) / 2
    const point = { x: to.x + (far.x - to.x) * mid, y: to.y + (far.y - to.y) * mid }
    if (outlineContains(shapeId, box, point, shapes)) hi = mid
    else lo = mid
  }
  return { x: to.x + (far.x - to.x) * hi, y: to.y + (far.y - to.y) * hi }
}

/** Clockwise convex polygon containment: the point must not lie strictly on
 * the outward side of any edge. */
function convexPolygonContains(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  point: { readonly x: number; readonly y: number },
): boolean {
  // Degenerate boxes collapse the vertices onto one point or one segment,
  // zeroing every cross product below — the loop alone would accept the
  // whole plane (point case) or the whole infinite line (segment case).
  // Bounding the point to the vertex box first makes both answer only
  // their own point/segment, and is a no-op for a real convex polygon: a
  // point outside the vertex box is outside the polygon anyway.
  const first = points[0]
  if (first === undefined) return false
  let minX = first.x
  let maxX = first.x
  let minY = first.y
  let maxY = first.y
  for (const p of points) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  if (point.x < minX || point.x > maxX || point.y < minY || point.y > maxY) return false
  // Either WINDING, not just the clockwise one every built-in happens to
  // use: the point is inside when it sits on the same side of every edge,
  // whichever side that is. A contributor does not think about winding and
  // both orders are valid, so requiring one made a correct polygon draw
  // normally while failing every hit test — and put its edge terminals back
  // on the bbox border. Zero crosses (a point ON an edge, or a degenerate
  // vertex pair) fix no sign, so the boundary keeps counting as inside.
  let sign = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)
    if (cross === 0) continue
    const current = cross > 0 ? 1 : -1
    if (sign === 0) sign = current
    else if (sign !== current) return false
  }
  return true
}
