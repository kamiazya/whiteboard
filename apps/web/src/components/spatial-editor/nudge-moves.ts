import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { EditorLeafCommand } from '../../lib/spatial/commands.js'
import { moveInkCommand } from '../../lib/spatial/ink-commands.js'

/**
 * The moves one nudge makes: every node in `ids` and every stroke in `inkIds`
 * by (dx, dy). Ink travels with the rest of the selection rather than in a
 * branch of its own, or a mixed selection would tear apart; an EDGE answers
 * nothing from `moveInkCommand`, since a relation's path is routed from the
 * boxes it joins and follows them.
 */
export function nudgeMoves(
  canvas: SpatialCanvas,
  ids: readonly string[],
  inkIds: readonly string[],
  dx: number,
  dy: number,
): EditorLeafCommand[] {
  const nodeMoves = ids.flatMap((id) => {
    const current = canvas.nodes.find((n) => n.id === id)
    return current === undefined
      ? []
      : [{ kind: 'move-node' as const, id: current.id, x: current.x + dx, y: current.y + dy }]
  })
  const inkMoves = inkIds.flatMap((id) => {
    const command = moveInkCommand(canvas, id, dx, dy)
    return command === undefined ? [] : [command]
  })
  return [...nodeMoves, ...inkMoves]
}
