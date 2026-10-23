/**
 * What a conversation is about, in a few words, so a list row can be told
 * apart from its neighbours: the node's first line of text for a node, and
 * the kind of place for everything that has no name of its own.
 */
import type { AnnotationAnchor, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { frameLabel, nodeText } from '@kamiazya/whiteboard-model'
import { nodeNoun } from './spatial/attach-target-label.js'

const NODE_NAME_MAX_CHARS = 28

function nodeName(canvas: SpatialCanvas | null, nodeId: string): string | undefined {
  const node = canvas?.nodes.find((entry) => entry.id === nodeId)
  const text = node === undefined ? undefined : (nodeText(node) ?? frameLabel(node))
  const line = text
    ?.split('\n')
    .map((entry) => entry.replace(/^[#>\-*\s]+/, '').trim())
    .find((entry) => entry !== '')
  if (line === undefined) return undefined
  return line.length > NODE_NAME_MAX_CHARS ? `${line.slice(0, NODE_NAME_MAX_CHARS - 1)}…` : line
}

/** An edge end named by its words, else by what kind of node it is. */
function endName(canvas: SpatialCanvas | null, nodeId: string): string | undefined {
  const named = nodeName(canvas, nodeId)
  if (named !== undefined) return named
  const node = canvas?.nodes.find((entry) => entry.id === nodeId)
  return node === undefined ? undefined : nodeNoun(node)
}

function edgeName(canvas: SpatialCanvas | null, edgeId: string): string | undefined {
  const edge = canvas?.edges.find((entry) => entry.id === edgeId)
  if (edge === undefined) return undefined
  const from = endName(canvas, edge.from.node)
  const to = endName(canvas, edge.to.node)
  return from === undefined || to === undefined ? undefined : `${from} → ${to}`
}

export function anchorChipLabel(anchor: AnnotationAnchor, canvas: SpatialCanvas | null): string {
  if (anchor.kind === 'document') return 'whole document'
  if (anchor.kind === 'text') {
    if (anchor.nodeId === undefined) return 'on a paragraph'
    const name = nodeName(canvas, anchor.nodeId)
    return name === undefined ? 'on a node' : `on ${name}`
  }
  if (anchor.nodeIds !== undefined) return `${anchor.nodeIds.length} nodes`
  if (anchor.width !== undefined) return 'region'
  if (anchor.nodeId !== undefined) {
    const name = nodeName(canvas, anchor.nodeId)
    return name === undefined ? 'on a node' : `on ${name}`
  }
  if (anchor.edgeId !== undefined) {
    const name = edgeName(canvas, anchor.edgeId)
    return name === undefined ? 'on an edge' : `on ${name}`
  }
  return 'on canvas'
}
