import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { isFrame } from '@kamiazya/whiteboard-model'
import { compareNumbers } from './det-math.js'

/**
 * Containers paint BEHIND what they hold, whatever order the canvas lists
 * them in: every group first, a larger one before a smaller (an outer group
 * before the one inside it), then everything else in stored order.
 * Stored order is a map's id order, not the order a caller wrote, so a group
 * whose id sorted after a member's painted over it once it had a colour —
 * four of eleven boxes vanished from a diagram whose grader, reading the
 * store, passed it. Equal boxes keep their stored order (the sort is
 * stable). The layout paints in this order and the web app's hit-test index
 * reads the same one.
 */
export function paintOrderOf(nodes: readonly SpatialNode[]): readonly SpatialNode[] {
  const groups = nodes
    .filter((node) => isFrame(node))
    .sort((a, b) => compareNumbers(b.width * b.height, a.width * a.height))
  return [...groups, ...nodes.filter((node) => !isFrame(node))]
}
