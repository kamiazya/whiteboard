import {
  frameLabel,
  isFrame,
  isImageRef,
  nodeFile,
  nodeText,
  nodeUrl,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { documentLabel } from '../../lib/document-label.js'

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
  // A stored image's reference is an opaque asset id and the node keeps no
  // file name, so it is named for what it is.
  if (file !== undefined && isImageRef(file)) return 'Image'
  if (file !== undefined) return `Document ${clip(documentLabel({ path: file }, 'leaf'))}`
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

function inkName(
  noun: string,
  ink: EdgeEnds & { readonly label?: string },
  nodes: readonly SpatialNode[],
): string {
  const base = `${noun} ${edgeRoute(ink, nodes)}`
  const label = ink.label?.trim()
  return label === undefined || label === '' ? base : `${base}: ${clip(label)}`
}

/** "Connection from A to B", with the label after it when the relation has one. */
export function edgeA11yName(
  edge: EdgeEnds & { readonly label?: string },
  nodes: readonly SpatialNode[],
): string {
  return inkName('Connection', edge, nodes)
}

/** "Line from A to empty space": a line is ink, so it is never called a connection. */
function lineA11yName(
  line: EdgeEnds & { readonly label?: string },
  nodes: readonly SpatialNode[],
): string {
  return inkName('Line', line, nodes)
}

/** What the controls around a selection act on: the one node by name, or how many when there are several. */
export function selectionSubject(primary: SpatialNode | undefined, extraCount: number): string {
  if (primary === undefined || extraCount > 0) return `${1 + extraCount} nodes`
  return nodeA11yName(primary)
}

/** The name of a connection or a line by id, whichever collection holds it. */
export function inkA11yName(
  canvas: Pick<SpatialCanvas, 'nodes' | 'edges' | 'lines'>,
  id: string,
): string | undefined {
  const edge = canvas.edges.find((entry) => entry.id === id)
  if (edge !== undefined) return edgeA11yName(edge, canvas.nodes)
  const line = (canvas.lines ?? []).find((entry) => entry.id === id)
  return line === undefined ? undefined : lineA11yName(line, canvas.nodes)
}
