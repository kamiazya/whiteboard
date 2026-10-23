import { frameLabel, nodeKind, nodeText, type SpatialNode } from '@kamiazya/whiteboard-model'

const MAX_NAME_CHARS = 40
const SHORT_ID_CHARS = 6

/** What to call a node that has no words of its own. */
export function nodeNoun(node: SpatialNode): string {
  const kind = nodeKind(node)
  return kind === 'text' ? 'text node' : kind === 'frame' ? 'group' : (kind ?? 'node')
}

/**
 * What an assistive-tech user hears for a box a connect could land on: the
 * node's own words when it has any, otherwise its kind and a short id so two
 * unnamed boxes stay distinguishable.
 */
export function attachTargetLabel(node: SpatialNode): string {
  const named = (nodeText(node) ?? frameLabel(node) ?? '').trim().split('\n')[0]?.trim() ?? ''
  if (named === '') {
    return `Attach to ${nodeNoun(node)} ${node.id.slice(0, SHORT_ID_CHARS)}`
  }
  const clipped = named.length > MAX_NAME_CHARS ? `${named.slice(0, MAX_NAME_CHARS)}…` : named
  return `Attach to '${clipped}'`
}
