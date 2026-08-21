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
