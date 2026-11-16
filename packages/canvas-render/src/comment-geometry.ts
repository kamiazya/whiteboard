/**
 * The annotation layer's geometry that outlives the layout it was drawn by:
 * where a comment points, and the constants the editor's compose and edit
 * bubbles share with the layer the Rust core draws (ADR-0024/0025/0026). The
 * layer itself is the core's; these are what the editor places its own
 * chrome by, so the draft opens where the layer will draw it.
 */

import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { commentCornerOf } from '@kamiazya/whiteboard-model'
import type { Point } from './generated/geometry.zod.js'

export const COMMENT_BUBBLE_PADDING_PX = 8
export const COMMENT_BUBBLE_RADIUS_PX = 8

/** Gap (px) from the anchor point to the bubble's nearest corner. */
export const COMMENT_BUBBLE_OFFSET_PX = 14

/**
 * The width a comment's prose is measured to when its surface names none.
 *
 * Narrow on purpose: a bubble floats over the canvas it annotates, and one
 * that grows with its text covers the thing being talked about.
 */
export const COMMENT_TEXT_MAX_WIDTH_PX = 200

/**
 * The point of a polyline nearest to `point` — where a comment about an
 * edge is pinned: the reader pressed somewhere near the line, and the pin
 * sits ON it, re-projected from the stored point each layout so it rides a
 * reroute. An empty path answers the point itself.
 */
function nearestPointOnPolyline(point: Point, path: readonly Point[]): Point {
  let best = point
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < path.length; i += 1) {
    const a = path[i] as Point
    const b = path[i + 1] ?? a
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSquared = dx * dx + dy * dy
    const t =
      lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
    const candidate = { x: a.x + t * dx, y: a.y + t * dy }
    const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/** The routed path of an edge, by id, as the layout drew it — absent when the edge is gone. */
export type EdgePathLookup = (edgeId: string) => readonly { x: number; y: number }[] | undefined

/**
 * Where a comment points: the target node's top-right corner while the node
 * exists (the pin FOLLOWS the node); the point of the target edge's routed
 * path nearest the stored anchor while the edge exists (the pin RIDES the
 * edge through a reroute); the stored anchor otherwise. The fallback is what
 * makes a dangling target harmless, per the model's contract that a comment
 * may outlive its subject.
 *
 * Exported because the editor places its compose bubble and its edit bubble
 * at the same anchor this layer draws from — one producer for the geometry,
 * so the draft cannot open one place and settle another. The editor passes
 * the paths it already flattened for hit-testing as `edgePathOf`; without
 * one, an edge comment stands at its stored point.
 */
export function commentAnchor(
  comment: CanvasComment,
  canvas: SpatialCanvas,
  edgePathOf?: EdgePathLookup,
): { readonly x: number; readonly y: number } {
  if (comment.targetNodeId !== undefined) {
    const target = canvas.nodes.find((node) => node.id === comment.targetNodeId)
    if (target !== undefined) return commentCornerOf(target)
  }
  if (comment.targetEdgeId !== undefined) {
    const path = edgePathOf?.(comment.targetEdgeId)
    if (path !== undefined && path.length > 0) {
      return nearestPointOnPolyline({ x: comment.x, y: comment.y }, path)
    }
  }
  return { x: comment.x, y: comment.y }
}
