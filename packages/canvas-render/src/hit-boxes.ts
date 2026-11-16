// The hit-test rule over plain boxes, with no import: the MCP Apps widget
// reads it through `picture/canvas-view-picture.ts` and must not pull the
// layout in to do so. `hit-test.ts` adds the node-shaped half.

export interface HitPoint {
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
