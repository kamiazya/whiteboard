import {
  frameLabel,
  isFrame,
  nodeFile,
  nodeText,
  nodeUrl,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'

const NAME_MAX_CHARS = 60

function clip(text: string): string {
  return text.length <= NAME_MAX_CHARS ? text : `${text.slice(0, NAME_MAX_CHARS - 1)}…`
}

/** The first line with something on it, with the markdown marks that read as noise aloud taken off. */
function firstLine(markdown: string): string {
  const line = markdown.split('\n').find((entry) => entry.trim() !== '') ?? ''
  return line
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/, '')
    .replace(/[*_`~]/g, '')
    .trim()
}

/**
 * What a screen reader calls a node: its own words, so "Review" is "Review"
 * and not "note 3". A frame says it is one; a node with nothing to read says
 * what it is instead of leaving an unnamed stop.
 */
export function nodeA11yName(node: SpatialNode): string {
  if (isFrame(node)) {
    const label = frameLabel(node)?.trim()
    return label === undefined || label === '' ? 'Frame' : `Frame ${clip(label)}`
  }
  const text = nodeText(node)
  if (text !== undefined) {
    const line = firstLine(text)
    return line === '' ? 'Empty note' : clip(line)
  }
  const file = nodeFile(node)
  if (file !== undefined) return `Document ${clip(file.split('/').at(-1) ?? file)}`
  const url = nodeUrl(node)
  if (url !== undefined) return `Link ${clip(url)}`
  return 'Node'
}

type EdgeEnds = { readonly from: object; readonly to: object }

/** "from A to B": the route a relation or a stroke takes, by the names of what it joins. */
export function edgeRoute(edge: EdgeEnds, nodes: readonly SpatialNode[]): string {
  const end = (side: object): string => {
    if (!('node' in side) || typeof side.node !== 'string') return 'empty space'
    const node = nodes.find((entry) => entry.id === side.node)
    return node === undefined ? 'a missing node' : nodeA11yName(node)
  }
  return `from ${end(edge.from)} to ${end(edge.to)}`
}

/** "Edge from A to B", with the label after it when the edge has one. */
export function edgeA11yName(
  edge: EdgeEnds & { readonly label?: string },
  nodes: readonly SpatialNode[],
): string {
  const base = `Edge ${edgeRoute(edge, nodes)}`
  const label = edge.label?.trim()
  return label === undefined || label === '' ? base : `${base}: ${clip(label)}`
}
