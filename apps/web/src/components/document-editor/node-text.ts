import type { SpatialCanvas } from '@kamiazya/whiteboard-model'

/**
 * The canvas with one text node's body replaced.
 *
 * Split out of the page because the page cannot easily prove it: its canvas
 * arrives through the CRDT sync hook rather than from its own `onChange`, so
 * a test there can observe the surface opening but not what the write did.
 * Here it is one input and one output.
 *
 * Returns the SAME canvas when nothing would change — an unchanged body, a
 * missing node, or a node that is not text. The caller uses that to avoid
 * writing a revision that says nothing.
 */
export function withNodeText(canvas: SpatialCanvas, nodeId: string, text: string): SpatialCanvas {
  const target = canvas.nodes.find((node) => node.id === nodeId)
  if (target === undefined || target.type !== 'text' || target.text === text) return canvas
  return {
    ...canvas,
    nodes: canvas.nodes.map((node) => (node.id === nodeId ? { ...node, text } : node)),
  }
}
