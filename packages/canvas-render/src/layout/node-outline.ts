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

import type { BoundingBox, NodeOutlineKind } from '../scene-graph.js'

export type { NodeOutlineKind }

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

export function nodeOutline(kind: NodeOutlineKind, box: BoundingBox): NodeOutline | null {
  if (!isFiniteBox(box)) return null
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  switch (kind) {
    case 'ellipse':
      return { kind: 'ellipse', cx, cy, rx: box.w / 2, ry: box.h / 2 }
    case 'diamond':
      // Edge-midpoint polygon, clockwise from the top vertex — the corner
      // order is fixed for deterministic serialization.
      return {
        kind: 'polygon',
        points: [
          { x: cx, y: box.y },
          { x: box.x + box.w, y: cy },
          { x: cx, y: box.y + box.h },
          { x: box.x, y: cy },
        ],
      }
    case 'hexagon': {
      // Pointy-left-right six-gon, clockwise from the top-left corner. The
      // corner inset is a quarter of the width, capped at half the height
      // so degenerate proportions stay a valid convex polygon.
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
    }
    case 'parallelogram': {
      // Right-leaning skew, clockwise from the top-left vertex; same
      // capped proportion as the hexagon inset.
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
    }
    case 'cylinder':
      return {
        kind: 'cylinder',
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        ry: Math.min(box.w * 0.1, box.h / 4),
      }
  }
}

/**
 * Point containment against the outline (boundary counts as inside) — the
 * hit-test half of the producer. Total: any non-finite input answers false.
 */
export function outlineContains(
  kind: NodeOutlineKind,
  box: BoundingBox,
  point: { readonly x: number; readonly y: number },
): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false
  const outline = nodeOutline(kind, box)
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
  kind: NodeOutlineKind,
  box: BoundingBox,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  if (!isFiniteBox(box)) return to
  if (![from.x, from.y, to.x, to.y].every(Number.isFinite)) return to
  if (outlineContains(kind, box, to)) return to
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
  if (!outlineContains(kind, box, far)) return to
  let lo = 0 // outside
  let hi = 1 // inside
  for (let i = 0; i < ENTRY_SEARCH_ITERATIONS; i++) {
    const mid = (lo + hi) / 2
    const point = { x: to.x + (far.x - to.x) * mid, y: to.y + (far.y - to.y) * mid }
    if (outlineContains(kind, box, point)) hi = mid
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
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)
    if (cross < 0) return false
  }
  return true
}
