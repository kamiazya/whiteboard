import { frameLabel, nodeKind, nodeText, type SpatialNode } from '@kamiazya/whiteboard-model'

const MAX_NAME_CHARS = 40
const SHORT_ID_CHARS = 6

/**
 * What an assistive-tech user hears for a box a connect could land on: the
 * node's own words when it has any, otherwise its kind and a short id so two
 * unnamed boxes stay distinguishable.
 */
export function attachTargetLabel(node: SpatialNode): string {
  const named = (nodeText(node) ?? frameLabel(node) ?? '').trim().split('\n')[0]?.trim() ?? ''
  if (named === '') {
    const kind = nodeKind(node)
    const noun = kind === 'text' ? 'text node' : kind === 'frame' ? 'group' : (kind ?? 'node')
    return `Attach to ${noun} ${node.id.slice(0, SHORT_ID_CHARS)}`
  }
  const clipped = named.length > MAX_NAME_CHARS ? `${named.slice(0, MAX_NAME_CHARS)}…` : named
  return `Attach to '${clipped}'`
}
