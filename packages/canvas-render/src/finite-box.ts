import type { BoundingBox } from '@kamiazya/whiteboard-scene'

/**
 * Whether every coordinate of a box is a real number. Layout and the SVG
 * backend each skip a box that is not, and both must agree on what that means
 * or a node would be laid out that cannot be drawn, so there is one definition
 * at the package's root, which both layers may import.
 */
export function isFiniteBox(box: BoundingBox): boolean {
  return [box.x, box.y, box.w, box.h].every(Number.isFinite)
}
