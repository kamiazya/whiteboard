import {
  frameHolds,
  isFrame,
  nodeKind,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { readingOrder } from '../../lib/spatial/reading-order.js'
import { edgeA11yName, edgeRoute, nodeA11yName } from './node-a11y-name.js'

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

const ADDED: Readonly<Record<string, string>> = {
  text: 'Note added',
  link: 'Link added',
  file: 'Document added',
  frame: 'Frame added',
}

function addedMessage(added: readonly SpatialNode[], next: SpatialCanvas) {
  const [only] = added
  if (added.length === 1 && only !== undefined) {
    if (isFrame(only)) {
      const members = next.nodes.filter(
        (node) => node.id !== only.id && !isFrame(node) && frameHolds(only, node),
      )
      if (members.length > 0) return `Grouped ${plural(members.length, 'node', 'nodes')}`
    }
    return ADDED[nodeKind(only) ?? ''] ?? 'Node added'
  }
  // Several at once is a paste, a duplicate or an undo: count, do not itemise.
  return `${added.length} nodes added`
}

/**
 * What a change to the canvas sounds like, for the one verb that caused it —
 * or undefined when nothing a reader would want to hear happened (a move, a
 * resize, a text edit). A node change outranks the edges that went with it.
 */
export function canvasChangeMessage(prev: SpatialCanvas, next: SpatialCanvas): string | undefined {
  const prevIds = new Set(prev.nodes.map((node) => node.id))
  const nextIds = new Set(next.nodes.map((node) => node.id))
  const added = next.nodes.filter((node) => !prevIds.has(node.id))
  const removed = prev.nodes.filter((node) => !nextIds.has(node.id))
  if (removed.length > 0 && added.length === 0) {
    return `Deleted ${plural(removed.length, 'node', 'nodes')}`
  }
  if (added.length > 0 && removed.length === 0) return addedMessage(added, next)

  const prevEdgeIds = new Set(prev.edges.map((edge) => edge.id))
  const nextEdgeIds = new Set(next.edges.map((edge) => edge.id))
  const newEdges = next.edges.filter((edge) => !prevEdgeIds.has(edge.id))
  const goneEdges = prev.edges.filter((edge) => !nextEdgeIds.has(edge.id))
  const [firstNew] = newEdges
  if (newEdges.length === 1 && firstNew !== undefined && goneEdges.length === 0) {
    return `Connected ${edgeRoute(firstNew, next.nodes).replace(/^from /, '')}`
  }
  if (newEdges.length > 1) return `${newEdges.length} edges added`
  if (goneEdges.length > 0 && newEdges.length === 0) {
    return `Deleted ${plural(goneEdges.length, 'edge', 'edges')}`
  }
  return undefined
}

/** What is selected, with its place among the nodes in the order Tab walks them. */
export function selectionMessage(
  canvas: SpatialCanvas,
  selectedNodeIds: readonly string[],
  selectedEdgeId: string | null,
): string | undefined {
  if (selectedNodeIds.length > 1) return `Selected ${selectedNodeIds.length} nodes`
  const [id] = selectedNodeIds
  if (id !== undefined) {
    const node = canvas.nodes.find((entry) => entry.id === id)
    if (node === undefined) return undefined
    const place = readingOrder(canvas.nodes).findIndex((entry) => entry.id === id) + 1
    return `Selected: ${nodeA11yName(node)} (${place} of ${canvas.nodes.length})`
  }
  if (selectedEdgeId !== null) {
    const edge = canvas.edges.find((entry) => entry.id === selectedEdgeId)
    return edge === undefined ? undefined : `Selected: ${edgeA11yName(edge, canvas.nodes)}`
  }
  return undefined
}
