/**
 * What a conversation is about, in a few words, so a list row can be told
 * apart from its neighbours: the node's first line of text for a node, and
 * the kind of place for everything that has no name of its own.
 */
import type { AnnotationAnchor, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { nodeText } from '@kamiazya/whiteboard-model'

const NODE_NAME_MAX_CHARS = 28

function nodeName(canvas: SpatialCanvas | null, nodeId: string): string | undefined {
  const node = canvas?.nodes.find((entry) => entry.id === nodeId)
  const text = node === undefined ? undefined : nodeText(node)
  const line = text
    ?.split('\n')
    .map((entry) => entry.replace(/^[#>\-*\s]+/, '').trim())
    .find((entry) => entry !== '')
  if (line === undefined) return undefined
  return line.length > NODE_NAME_MAX_CHARS ? `${line.slice(0, NODE_NAME_MAX_CHARS - 1)}…` : line
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
  if (anchor.edgeId !== undefined) return 'on an edge'
  return 'on canvas'
}
