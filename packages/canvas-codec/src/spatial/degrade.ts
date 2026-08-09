import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'

/**
 * Strict JSON Canvas 1.0 has no room for the `x-whiteboard` extension.
 * Degradation is ONE uniform rule applied per-node: drop the entire
 * `x-whiteboard` key. There is no per-kind special casing — an embed
 * file-node keeps its base `file`/`subpath` fields (those are plain JSON
 * Canvas, not part of the extension) and only loses `x-whiteboard.canvasId`
 * because the whole extension object it lived in is gone. Edges carry no
 * `x-whiteboard` field at all, so they pass through unchanged.
 */
function degradeNode(node: SpatialNode): SpatialNode {
  const { 'x-whiteboard': _xWhiteboard, ...rest } = node
  return rest as SpatialNode
}

/**
 * The canvas-level `x-whiteboard` (rendering preferences, e.g. edge routing
 * style) goes the same way, and for the same reason: strict JSON Canvas has
 * no room for it. Rebuilding from nodes and edges alone is what drops it —
 * spelled out here because "the object literal happens not to mention it" is
 * not a contract anyone can rely on.
 */
export function strictDegrade(canvas: SpatialCanvas): SpatialCanvas {
  return {
    nodes: canvas.nodes.map(degradeNode),
    edges: canvas.edges,
  }
}
