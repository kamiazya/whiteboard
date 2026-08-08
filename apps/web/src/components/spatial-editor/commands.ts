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
 * unchanged rather than throwing. `create-node` carries a full canvas-model
 * `SpatialNode` (rather than a flattened x/y/w/h/text tuple) so a later node
 * kind needs no command-shape change; a colliding id is likewise a no-op.
 * `delete-node` cascades: it also removes every edge whose `fromNode`/
 * `toNode` referenced the removed node, so no command sequence can ever
 * produce a canvas with a dangling edge endpoint.
 */
import type {
  CanvasColor,
  CanvasEdge,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-canvas-model'

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
  | { readonly kind: 'create-node'; readonly node: SpatialNode }
  | { readonly kind: 'delete-node'; readonly id: string }
  | { readonly kind: 'delete-edge'; readonly id: string }
  | { readonly kind: 'set-edge-label'; readonly id: string; readonly label: string }
  | {
      readonly kind: 'set-edge-ends'
      readonly id: string
      readonly fromEnd: 'none' | 'arrow'
      readonly toEnd: 'none' | 'arrow'
    }
  | {
      readonly kind: 'set-node-color'
      readonly id: string
      // undefined returns the object to the theme default (field removed).
      readonly color: CanvasColor | undefined
    }
  | {
      readonly kind: 'set-edge-color'
      readonly id: string
      readonly color: CanvasColor | undefined
    }
  | {
      // Rewrites a link node's destination. Only link nodes carry a url —
      // any other target (or a missing id) is a no-op, never a corruption.
      readonly kind: 'set-node-url'
      readonly id: string
      readonly url: string
    }
  | {
      readonly kind: 'set-edge-side'
      readonly id: string
      readonly endpoint: 'from' | 'to'
      // undefined returns the endpoint to derived (auto) routing.
      readonly side: 'top' | 'right' | 'bottom' | 'left' | undefined
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
  // spatialCanvasSchema rejects duplicate edges[].id, so a colliding
  // generated id must be rejected here too, or the resulting canvas would
  // fail validation downstream.
  const edgeIdExists = canvas.edges.some((edge) => edge.id === edgeId)
  if (edgeIdExists) return canvas
  const edge: CanvasEdge = { id: edgeId, fromNode, toNode }
  return { ...canvas, edges: [...canvas.edges, edge] }
}

/**
 * Appends `node`. Rejects a colliding id as a no-op — mirroring
 * `connectNodes`'s duplicate-edge-id guard — so a caller can never produce a
 * canvas that fails `spatialCanvasSchema`'s implicit unique-id expectation.
 */
function createNode(canvas: SpatialCanvas, node: SpatialNode): SpatialCanvas {
  const idExists = canvas.nodes.some((existing) => existing.id === node.id)
  if (idExists) return canvas
  return { ...canvas, nodes: [...canvas.nodes, node] }
}

/**
 * Removes the node with `id` plus every edge that references it as
 * `fromNode`/`toNode` — the command-layer half of the edge-referential-
 * integrity invariant `deleteSpatialNode` (canvas-workspace) also enforces
 * on the Loro side. A no-op (returns the input) when `id` is missing.
 */
function deleteNode(canvas: SpatialCanvas, id: string): SpatialCanvas {
  const idExists = canvas.nodes.some((node) => node.id === id)
  if (!idExists) return canvas
  return {
    ...canvas,
    nodes: canvas.nodes.filter((node) => node.id !== id),
    edges: canvas.edges.filter((edge) => edge.fromNode !== id && edge.toNode !== id),
  }
}

/** An empty label removes the field: the model's `label` is optional and an
 * empty string would serialize as an authored-but-blank label. */
/** Ends equal to the JSON Canvas defaults (fromEnd none, toEnd arrow) are
 * removed rather than written, keeping the stored document canonical. */
function setEdgeEnds(
  canvas: SpatialCanvas,
  id: string,
  fromEnd: 'none' | 'arrow',
  toEnd: 'none' | 'arrow',
): SpatialCanvas {
  if (!canvas.edges.some((edge) => edge.id === id)) return canvas
  return {
    ...canvas,
    edges: canvas.edges.map((edge) => {
      if (edge.id !== id) return edge
      const { fromEnd: _from, toEnd: _to, ...rest } = edge
      return {
        ...rest,
        ...(fromEnd === 'none' ? {} : { fromEnd }),
        ...(toEnd === 'arrow' ? {} : { toEnd }),
      }
    }),
  }
}

/** `color: undefined` removes the field — the theme default, canonically. */
function setNodeColor(
  canvas: SpatialCanvas,
  id: string,
  color: CanvasColor | undefined,
): SpatialCanvas {
  if (!canvas.nodes.some((node) => node.id === id)) return canvas
  return {
    ...canvas,
    nodes: canvas.nodes.map((node) => {
      if (node.id !== id) return node
      const { color: _removed, ...rest } = node
      return color === undefined ? rest : { ...rest, color }
    }),
  }
}

function setNodeUrl(canvas: SpatialCanvas, id: string, url: string): SpatialCanvas {
  if (!canvas.nodes.some((node) => node.id === id && node.type === 'link')) return canvas
  return {
    ...canvas,
    nodes: canvas.nodes.map((node) =>
      node.id === id && node.type === 'link' ? { ...node, url } : node,
    ),
  }
}

function setEdgeColor(
  canvas: SpatialCanvas,
  id: string,
  color: CanvasColor | undefined,
): SpatialCanvas {
  if (!canvas.edges.some((edge) => edge.id === id)) return canvas
  return {
    ...canvas,
    edges: canvas.edges.map((edge) => {
      if (edge.id !== id) return edge
      const { color: _removed, ...rest } = edge
      return color === undefined ? rest : { ...rest, color }
    }),
  }
}

/** `side: undefined` removes the pin so routing derives the side again. */
function setEdgeSide(
  canvas: SpatialCanvas,
  id: string,
  endpoint: 'from' | 'to',
  side: 'top' | 'right' | 'bottom' | 'left' | undefined,
): SpatialCanvas {
  if (!canvas.edges.some((edge) => edge.id === id)) return canvas
  const key = endpoint === 'from' ? 'fromSide' : 'toSide'
  return {
    ...canvas,
    edges: canvas.edges.map((edge) => {
      if (edge.id !== id) return edge
      const { [key]: _removed, ...rest } = edge
      return side === undefined ? rest : { ...rest, [key]: side }
    }),
  }
}

function setEdgeLabel(canvas: SpatialCanvas, id: string, label: string): SpatialCanvas {
  if (!canvas.edges.some((edge) => edge.id === id)) return canvas
  return {
    ...canvas,
    edges: canvas.edges.map((edge) => {
      if (edge.id !== id) return edge
      if (label === '') {
        const { label: _removed, ...rest } = edge
        return rest
      }
      return { ...edge, label }
    }),
  }
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
    case 'create-node':
      return createNode(canvas, command.node)
    case 'delete-edge':
      return { ...canvas, edges: canvas.edges.filter((edge) => edge.id !== command.id) }
    case 'set-edge-label':
      return setEdgeLabel(canvas, command.id, command.label)
    case 'set-edge-ends':
      return setEdgeEnds(canvas, command.id, command.fromEnd, command.toEnd)
    case 'set-edge-side':
      return setEdgeSide(canvas, command.id, command.endpoint, command.side)
    case 'set-node-color':
      return setNodeColor(canvas, command.id, command.color)
    case 'set-edge-color':
      return setEdgeColor(canvas, command.id, command.color)
    case 'set-node-url':
      return setNodeUrl(canvas, command.id, command.url)
    case 'delete-node':
      return deleteNode(canvas, command.id)
  }
}
