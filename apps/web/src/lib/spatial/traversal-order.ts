/**
 * The keyboard walk over a whole board: every node in reading order, each
 * followed by the connections and lines that start at it. A diagram reads
 * "A, A to B, B", so a connection is reached from the node it leaves rather
 * than from a key of its own, and a person who can Tab to a node can Tab to
 * what it points at. Ink with no node to start from (a free line, or one from
 * a node that is gone) closes the walk.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { readingOrder } from './reading-order.js'

export type TraversalStop =
  | { readonly kind: 'node'; readonly id: string }
  /** A connection or a line; `anchorId` is the node it was reached from, if any. */
  | { readonly kind: 'ink'; readonly id: string; readonly anchorId: string | null }

type Board = Pick<SpatialCanvas, 'nodes' | 'edges' | 'lines'>

interface InkEntry {
  readonly id: string
  readonly anchorId: string | null
}

/** Where a piece of ink hangs in the walk: the node it starts at, else the node it ends at. */
function inkEntries(board: Board): InkEntry[] {
  const nodeIds = new Set(board.nodes.map((node) => node.id))
  const known = (id: string | undefined) => (id !== undefined && nodeIds.has(id) ? id : null)
  const edges = board.edges.map((edge) => ({ id: edge.id, anchorId: known(edge.from.node) }))
  const lines = (board.lines ?? []).map((line) => {
    const from = line.from.kind === 'node' ? known(line.from.node) : null
    const to = line.to.kind === 'node' ? known(line.to.node) : null
    return { id: line.id, anchorId: from ?? to }
  })
  return [...edges, ...lines]
}

/**
 * Every stop the walk makes, in order. A locked element cannot be selected,
 * so it is no stop — but a locked node still holds its place for the
 * connections that leave it.
 */
export function traversalStops(
  board: Board,
  locks: {
    readonly isNodeLocked: (id: string) => boolean
    readonly isInkLocked: (id: string) => boolean
  },
): TraversalStop[] {
  const ink = inkEntries(board).filter((entry) => !locks.isInkLocked(entry.id))
  const stops: TraversalStop[] = []
  for (const node of readingOrder(board.nodes)) {
    if (!locks.isNodeLocked(node.id)) stops.push({ kind: 'node', id: node.id })
    for (const entry of ink) {
      if (entry.anchorId === node.id) stops.push({ kind: 'ink', ...entry })
    }
  }
  for (const entry of ink) {
    if (entry.anchorId === null) stops.push({ kind: 'ink', ...entry })
  }
  return stops
}

/**
 * The stop one step from `current`. Does not wrap, so a step off either end
 * answers undefined and Tab can leave the canvas; with nothing current (or a
 * current that is no stop) a forward step lands on the first, a backward one
 * on the last.
 */
export function stepTraversal(
  stops: readonly TraversalStop[],
  current: { readonly kind: 'node' | 'ink'; readonly id: string } | null,
  step: 1 | -1,
): TraversalStop | undefined {
  if (stops.length === 0) return undefined
  const at =
    current === null
      ? -1
      : stops.findIndex((stop) => stop.kind === current.kind && stop.id === current.id)
  if (at < 0) return step === 1 ? stops[0] : stops[stops.length - 1]
  return stops[at + step]
}

/** A connection's or line's place among the board's ink, in the order the walk reaches it. */
export function inkPlace(board: Board, id: string): { place: number; of: number } | undefined {
  const order = traversalStops(board, { isNodeLocked: () => false, isInkLocked: () => false })
    .filter((stop) => stop.kind === 'ink')
    .map((stop) => stop.id)
  const at = order.indexOf(id)
  return at < 0 ? undefined : { place: at + 1, of: order.length }
}
