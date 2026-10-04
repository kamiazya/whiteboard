import { isFrame, type SpatialNode } from '@kamiazya/whiteboard-model'
import { paintOrderOf } from './layout/spatial-canvas.js'

interface HitPoint {
  readonly x: number
  readonly y: number
}

interface HitRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One candidate for a pointer hit: a node's box, flagged when it is a frame. */
export interface HitBox {
  readonly id: string
  /** True for a frame: it yields to any content node under the same point. */
  readonly container?: boolean
  readonly box: HitRect
}

/** Inclusive of the box edge — a point exactly on the boundary is "inside". */
export function boxContains(box: HitRect, point: HitPoint): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  )
}

/**
 * The id under `point`, or undefined for empty space, over boxes given in
 * PAINT order (`paintOrderOf`), so "last" is "on top".
 *
 * A frame paints behind what it holds, and membership is geometric, so its
 * z-order against a member carries no occlusion meaning: a content node under
 * the pointer is always the one the user sees and wins over any frame. A frame
 * is hit only where no content node is — its padding — and the innermost one
 * when frames nest.
 */
export function topmostHit(boxes: readonly HitBox[], point: HitPoint): string | undefined {
  let containerHit: string | undefined
  for (let i = boxes.length - 1; i >= 0; i -= 1) {
    const candidate = boxes[i]
    if (candidate === undefined || !boxContains(candidate.box, point)) continue
    if (candidate.container !== true) return candidate.id
    containerHit ??= candidate.id
  }
  return containerHit
}

/**
 * The node a click on the canvas lands on, whatever order the document stores
 * its nodes in — stored order is a map's id order, not the picture, so a scan
 * in it names a frame that merely sorts before the member drawn over it.
 */
export function topmostNodeAt(
  nodes: readonly SpatialNode[],
  point: HitPoint,
): SpatialNode | undefined {
  const id = topmostHit(
    paintOrderOf(nodes).map((node) => ({
      id: node.id,
      ...(isFrame(node) ? { container: true } : {}),
      box: node,
    })),
    point,
  )
  return id === undefined ? undefined : nodes.find((node) => node.id === id)
}
