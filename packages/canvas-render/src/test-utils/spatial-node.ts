import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'

/**
 * A text node at a position and size, its text its own id.
 *
 * The text is the id so a failing assertion that prints a node names it, and
 * so two nodes never compare equal by accident. Layout and routing tests
 * care about the geometry; the text only has to be there.
 */
export const node = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): SpatialNode => textNode({ id, x, y, width, height, text: id })
