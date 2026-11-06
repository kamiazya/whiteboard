import {
  frameHolds,
  frameLabel,
  isFrame,
  nodeKind,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { isFreehandStroke } from '../../lib/spatial/freehand.js'
import { readingOrder } from '../../lib/spatial/reading-order.js'
import { inkPlace } from '../../lib/spatial/traversal-order.js'
import { edgeRoute, inkA11yName, nodeA11yName } from './node-a11y-name.js'

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
      if (members.length > 0) return `Framed ${plural(members.length, 'node', 'nodes')}`
    }
    return ADDED[nodeKind(only) ?? ''] ?? 'Node added'
  }
  // Several at once is a paste, a duplicate or an undo: count, do not itemise.
  return `${added.length} nodes added`
}

/** The innermost frame holding `node`, the node itself excluded. */
function frameOf(node: SpatialNode, nodes: readonly SpatialNode[]): SpatialNode | undefined {
  let inner: SpatialNode | undefined
  for (const candidate of nodes) {
    if (candidate.id === node.id || !isFrame(candidate) || !frameHolds(candidate, node)) continue
    if (inner === undefined || candidate.width * candidate.height < inner.width * inner.height) {
      inner = candidate
    }
  }
  return inner
}

function frameName(frame: SpatialNode): string {
  const label = frameLabel(frame)?.trim()
  return label === undefined || label === '' ? 'a frame' : label
}

/**
 * A move that took a node into, out of, or across a frame. Only nodes that
 * themselves moved count, so a frame dragged over a note at rest is not the
 * note "moving in", and a frame carrying its notes changes nobody's frame.
 * Moves inside one frame say nothing, which is what keeps a run of nudges
 * from flooding the reader: only the press that crosses an edge speaks.
 */
function membershipMessage(prev: SpatialCanvas, next: SpatialCanvas): string | undefined {
  const crossings = next.nodes.flatMap((node) => {
    const before = prev.nodes.find((entry) => entry.id === node.id)
    if (before === undefined || (before.x === node.x && before.y === node.y)) return []
    const was = frameOf(before, prev.nodes)
    const now = frameOf(node, next.nodes)
    return was?.id === now?.id ? [] : [{ node, was, now }]
  })
  const [only] = crossings
  if (only === undefined) return undefined
  if (crossings.length > 1) return `${crossings.length} nodes changed frame`
  const name = nodeA11yName(only.node)
  const { was, now } = only
  if (was === undefined)
    return now === undefined ? undefined : `${name} moved into ${frameName(now)}`
  if (now === undefined) return `${name} left ${frameName(was)}`
  return `${name} moved from ${frameName(was)} into ${frameName(now)}`
}

/**
 * What a change to the canvas sounds like, for the one verb that caused it —
 * or undefined when nothing a reader would want to hear happened (a resize,
 * a text edit, a move that stays in its frame). A node change outranks the edges
 * that went with it, and both outrank a move across a frame's edge.
 */
export function canvasChangeMessage(
  prev: SpatialCanvas,
  next: SpatialCanvas,
  /** The eraser is what removed them, so drawings are said to be erased. */
  erasing = false,
): string | undefined {
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
  return goneLinesMessage(prev, next, erasing) ?? membershipMessage(prev, next)
}

/**
 * Ink taken away, said as a node deletion is: "Deleted 1 drawing" for strokes
 * somebody drew, "Deleted 2 lines" once any ruled line is among them — and
 * "Erased 2 drawings" when the eraser took them, the verb the person used.
 */
function goneLinesMessage(
  prev: SpatialCanvas,
  next: SpatialCanvas,
  erasing: boolean,
): string | undefined {
  const kept = new Set((next.lines ?? []).map((line) => line.id))
  const gone = (prev.lines ?? []).filter((line) => !kept.has(line.id))
  if (gone.length === 0) return undefined
  return gone.every(isFreehandStroke)
    ? `${erasing ? 'Erased' : 'Deleted'} ${plural(gone.length, 'drawing', 'drawings')}`
    : `Deleted ${plural(gone.length, 'line', 'lines')}`
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
    const frame = frameOf(node, canvas.nodes)
    const where = frame === undefined ? '' : `, in ${frameName(frame)}`
    return `Selected: ${nodeA11yName(node)}${where} (${place} of ${canvas.nodes.length})`
  }
  if (selectedEdgeId !== null) {
    const name = inkA11yName(canvas, selectedEdgeId)
    const at = inkPlace(canvas, selectedEdgeId)
    return name === undefined || at === undefined
      ? undefined
      : `Selected: ${name} (${at.place} of ${at.of})`
  }
  return undefined
}

/** A box a tidy or an arrange verb wants a node moved (and, for a frame, resized) to. */
interface BoxMoveLike {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width?: number
  readonly height?: number
}

/**
 * What a tidy did, said once the menu that ran it has closed: the notes it
 * moved and the frames they sit in, or that there was nothing to do — a
 * tidy that answers with silence reads exactly like one that did not run.
 */
export function tidyMessage(nodes: readonly SpatialNode[], moves: readonly BoxMoveLike[]): string {
  const after = nodes.map((node) => {
    const move = moves.find((entry) => entry.id === node.id)
    return move === undefined ? node : { ...node, ...move }
  })
  const changed = after.filter((node, index) => {
    const before = nodes[index]
    return (
      before !== undefined &&
      (before.x !== node.x ||
        before.y !== node.y ||
        before.width !== node.width ||
        before.height !== node.height)
    )
  })
  if (changed.length === 0) return 'Already tidy'
  const notes = changed.filter((node) => !isFrame(node))
  if (notes.length === 0) return `Tidied ${plural(changed.length, 'frame', 'frames')}`
  const frames = new Set(notes.flatMap((node) => frameOf(node, after)?.id ?? []))
  const where = frames.size === 0 ? '' : ` in ${plural(frames.size, 'frame', 'frames')}`
  return `Tidied ${plural(notes.length, 'note', 'notes')}${where}`
}
