import { isFrame, type SpatialNode } from '@kamiazya/whiteboard-model'
import type { HitBox } from './hit-boxes.js'
import { paintOrderOf } from './paint-order.js'

export { boxContains, type HitBox, topmostHit } from './hit-boxes.js'

/**
 * The node a click on the canvas lands on is `topmostHit` over these, whatever
 * order the document stores its nodes in — stored order is a map's id order,
 * not the picture, so a scan in it names a frame that merely sorts before the
 * member drawn over it.
 *
 * The hit candidates a set of nodes offers, in PAINT order — what
 * `topmostHit` reads. The MCP Apps widget receives exactly these beside the
 * SVG the daemon drew (`canvasViewPictureSchema`), so a click there names the
 * node a click on the same spot in the editor would.
 */
export function hitBoxesOf(nodes: readonly SpatialNode[]): HitBox[] {
  return paintOrderOf(nodes).map((node) => ({
    id: node.id,
    ...(isFrame(node) ? { container: true } : {}),
    box: { x: node.x, y: node.y, width: node.width, height: node.height },
  }))
}
