/**
 * The order a person reads a board in, and the neighbour a direction key
 * means — the two questions keyboard-only traversal asks of node geometry.
 * Pure, so the key handler and its tests share one answer.
 */
import { compareCodeUnit } from '@kamiazya/whiteboard-model'

export interface PlacedNode {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type Direction = 'up' | 'down' | 'left' | 'right'

/** Top to bottom, then left to right by box position; ties fall to the id. */
function readingOrder<T extends PlacedNode>(nodes: readonly T[]): T[] {
  return [...nodes].sort((a, b) => a.y - b.y || a.x - b.x || compareCodeUnit(a.id, b.id))
}

/**
 * The id one step from `currentId` in reading order, wrapping at both ends.
 * With no current node a forward step lands on the first and a backward step
 * on the last; an id that is no longer on the board counts as no node.
 */
export function nextInReadingOrder(
  nodes: readonly PlacedNode[],
  currentId: string | null,
  step: 1 | -1,
): string | undefined {
  const ordered = readingOrder(nodes)
  if (ordered.length === 0) return undefined
  const at = currentId === null ? -1 : ordered.findIndex((n) => n.id === currentId)
  if (at < 0) return (step === 1 ? ordered[0] : ordered[ordered.length - 1])?.id
  return ordered[(at + step + ordered.length) % ordered.length]?.id
}

/** Off-axis distance costs double: a node straight ahead beats a nearer one off to the side. */
const OFF_AXIS_WEIGHT = 2

/** The unit step of each direction, so "ahead" and "to the side" are two dot products. */
const STEP: Readonly<Record<Direction, { readonly x: number; readonly y: number }>> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}

const centreOf = (n: PlacedNode) => ({ x: n.x + n.width / 2, y: n.y + n.height / 2 })

/**
 * The node whose centre lies nearest in `direction` from `fromId`'s centre,
 * counting only nodes strictly beyond it on that axis. Ties fall to the id.
 */
export function nearestInDirection(
  nodes: readonly PlacedNode[],
  fromId: string,
  direction: Direction,
): string | undefined {
  const from = nodes.find((n) => n.id === fromId)
  if (from === undefined) return undefined
  const origin = centreOf(from)
  const step = STEP[direction]
  const scored = nodes.flatMap((n) => {
    if (n.id === fromId) return []
    const c = centreOf(n)
    const dx = c.x - origin.x
    const dy = c.y - origin.y
    const along = dx * step.x + dy * step.y
    if (along <= 0) return []
    const across = Math.abs(dx * step.y) + Math.abs(dy * step.x)
    return [{ id: n.id, score: along + OFF_AXIS_WEIGHT * across }]
  })
  scored.sort((a, b) => a.score - b.score || compareCodeUnit(a.id, b.id))
  return scored[0]?.id
}
