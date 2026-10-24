import { commentCornerOf, isFrame, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { Box } from '../../lib/spatial/geometry.js'
import { canvasToScreen, type Point, type Viewport } from '../../lib/spatial/viewport.js'
import type { ContextMenuTarget } from './CanvasContextMenu.js'
import type { CommentComposeState } from './canvas-commands.js'
import { commentOnNodesCompose } from './context-menu-items/annotation-verbs.js'

export interface KeyboardMenuInputs {
  /** The selected node and the box its handles surround (the whole set's, for a multi-selection). */
  readonly nodeSelection: { readonly id: string; readonly box: Box } | undefined
  /** Selected strokes and relations, the primary first. */
  readonly selectedInkIds: readonly string[]
  readonly edgePathOf: (id: string) => readonly Point[] | undefined
  readonly viewport: Viewport
  /** Screen point of the middle of the view, for a menu about no object. */
  readonly viewCenterScreen: Point
  /** The vessel to draw: a narrow editor takes the bottom sheet. */
  readonly variant: 'grid' | 'sheet'
}

/** The middle of a routed path, which is on the edge wherever it bends. */
function pathMiddle(path: readonly Point[]): Point | undefined {
  const a = path[Math.floor((path.length - 1) / 2)]
  const b = path[Math.floor(path.length / 2)]
  if (a === undefined || b === undefined) return undefined
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * The menu a right-click on the current selection would open — the node's
 * (or the whole set's), else the relation's, else the canvas's — anchored AT
 * the selection and marked to take focus on its first row, since a keyboard
 * user has no pointer to land on one.
 */
export function selectionMenuTarget(input: KeyboardMenuInputs): ContextMenuTarget {
  const { nodeSelection, selectedInkIds, edgePathOf, viewport, viewCenterScreen, variant } = input
  const inkId = selectedInkIds[0]
  const inkPoint = inkId === undefined ? undefined : pathMiddle(edgePathOf(inkId) ?? [])
  if (nodeSelection !== undefined) {
    const { box } = nodeSelection
    const point = { x: box.x, y: box.y + box.height }
    const screen = canvasToScreen(point, viewport)
    return {
      ...screen,
      nodeId: nodeSelection.id,
      edgeId: undefined,
      point,
      variant,
    }
  }
  if (inkId !== undefined && inkPoint !== undefined) {
    const screen = canvasToScreen(inkPoint, viewport)
    return {
      ...screen,
      nodeId: undefined,
      edgeId: inkId,
      point: inkPoint,
      variant,
    }
  }
  const point = {
    x: viewCenterScreen.x / viewport.zoom + viewport.x,
    y: viewCenterScreen.y / viewport.zoom + viewport.y,
  }
  return {
    ...viewCenterScreen,
    nodeId: undefined,
    edgeId: undefined,
    point,
    variant,
  }
}

/**
 * The composer a "Comment on this" in the selection's menu would open, for
 * the keyboard shortcut that skips the menu. A set is one conversation about
 * the set; a stroke has no comment verb, so it answers nothing.
 */
export function selectionCommentCompose(input: {
  readonly canvas: SpatialCanvas
  /** Selected node ids, the primary first. */
  readonly nodeIds: readonly string[]
  readonly selectedInkIds: readonly string[]
  readonly edgePathOf: (id: string) => readonly Point[] | undefined
}): CommentComposeState | undefined {
  const { canvas, nodeIds, selectedInkIds, edgePathOf } = input
  const primary = canvas.nodes.find((node) => node.id === nodeIds[0])
  if (primary !== undefined) {
    return nodeIds.length > 1
      ? commentOnNodesCompose(canvas, nodeIds, primary)
      : { point: commentCornerOf(primary), targetNodeId: primary.id }
  }
  const edge = canvas.edges.find((entry) => entry.id === selectedInkIds[0])
  const middle = edge === undefined ? undefined : pathMiddle(edgePathOf(edge.id) ?? [])
  if (edge === undefined || middle === undefined) return undefined
  return {
    point: { x: Math.round(middle.x), y: Math.round(middle.y) },
    targetEdgeId: edge.id,
  }
}

const countOf = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * What the canvas root announces: what it holds, frames and connections
 * apart from notes, and how a keyboard user continues from where they are.
 */
export function canvasRootLabel(
  canvas: SpatialCanvas,
  selectedId: string | null,
  selectedEdgeId: string | null,
): string {
  const hasSelection = selectedId !== null || selectedEdgeId !== null
  if (canvas.nodes.length === 0) return 'Canvas, empty'
  const frames = canvas.nodes.filter(isFrame).length
  const parts = [
    countOf(canvas.nodes.length - frames, 'note', 'notes'),
    ...(frames > 0 ? [countOf(frames, 'frame', 'frames')] : []),
    ...(canvas.edges.length > 0 ? [countOf(canvas.edges.length, 'connection', 'connections')] : []),
  ]
  return `Canvas, ${parts.join(', ')}. ${hasSelection ? 'Tab selects the next node' : 'Tab selects the first note'}`
}
