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
