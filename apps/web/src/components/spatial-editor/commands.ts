/**
 * `EditorCommand` is the single, pure, immutable mutation point for the
 * spatial editor: every gesture that changes the canvas produces one of
 * these, and `applyCommand` turns it into a NEW `SpatialCanvas` value —
 * the input is never mutated.
 *
 * This is a process-internal type (it never crosses a process boundary in
 * this slice), so per zod-schema-discipline it deliberately has no Zod
 * schema. If a later slice serializes commands to the sync layer, that is
 * the point to add one.
 *
 * `applyCommand` is total: a command whose target id is missing, or whose
 * kind does not apply to the target node's type, returns the INPUT canvas
 * unchanged rather than throwing.
 */
import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'

export type EditorCommand =
  | { readonly kind: 'move-node'; readonly id: string; readonly x: number; readonly y: number }
  | {
      readonly kind: 'resize-node'
      readonly id: string
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
    }
  | { readonly kind: 'set-text'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'connect-nodes'
      readonly edgeId: string
      readonly fromNode: string
      readonly toNode: string
    }

/** spatialCanvasSchema requires integer x/y and non-negative integer w/h. */
function toPosition(value: number): number {
  return Math.round(value)
}

function toSize(value: number): number {
  return Math.max(0, Math.round(value))
}

/**
 * Replaces the node with `id` by `update(node)`. Returns the input canvas
 * unchanged when the node is missing or `update` declines it (returns
 * undefined) — the totality guarantee documented above.
 */
function updateNode(
  canvas: SpatialCanvas,
  id: string,
  update: (node: SpatialNode) => SpatialNode | undefined,
): SpatialCanvas {
  const index = canvas.nodes.findIndex((node) => node.id === id)
  const target = index === -1 ? undefined : canvas.nodes[index]
  if (target === undefined) return canvas
  const updated = update(target)
  if (updated === undefined) return canvas
  const nodes = canvas.nodes.slice()
  nodes[index] = updated
  return { ...canvas, nodes }
}

function moveNode(canvas: SpatialCanvas, id: string, x: number, y: number): SpatialCanvas {
  return updateNode(canvas, id, (node) => ({ ...node, x: toPosition(x), y: toPosition(y) }))
}

function resizeNode(
  canvas: SpatialCanvas,
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): SpatialCanvas {
  return updateNode(canvas, id, (node) => ({
    ...node,
    x: toPosition(x),
    y: toPosition(y),
    width: toSize(width),
    height: toSize(height),
  }))
}

function setText(canvas: SpatialCanvas, id: string, text: string): SpatialCanvas {
  return updateNode(canvas, id, (node) => (node.type === 'text' ? { ...node, text } : undefined))
}

function connectNodes(
  canvas: SpatialCanvas,
  edgeId: string,
  fromNode: string,
  toNode: string,
): SpatialCanvas {
  if (fromNode === toNode) return canvas
  const fromExists = canvas.nodes.some((node) => node.id === fromNode)
  const toExists = canvas.nodes.some((node) => node.id === toNode)
  if (!fromExists || !toExists) return canvas
  const edge: CanvasEdge = { id: edgeId, fromNode, toNode }
  return { ...canvas, edges: [...canvas.edges, edge] }
}

export function applyCommand(canvas: SpatialCanvas, command: EditorCommand): SpatialCanvas {
  switch (command.kind) {
    case 'move-node':
      return moveNode(canvas, command.id, command.x, command.y)
    case 'resize-node':
      return resizeNode(canvas, command.id, command.x, command.y, command.width, command.height)
    case 'set-text':
      return setText(canvas, command.id, command.text)
    case 'connect-nodes':
      return connectNodes(canvas, command.edgeId, command.fromNode, command.toNode)
  }
}
