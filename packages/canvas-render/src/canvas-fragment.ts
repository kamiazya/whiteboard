import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { endNode } from '@kamiazya/whiteboard-model'

/**
 * The part of a canvas a `#fragment` names, as a canvas of its own.
 *
 * Two spellings, resolved readable-first and durable-second, the order every
 * address in this project uses (ADR-0019): a bare fragment is a GROUP's
 * label — the one structure a canvas's author names, and the counterpart of
 * a markdown heading — and `^` followed by a node id is the durable form,
 * which the picker may write but a person is never asked to. An exact
 * label wins over a case-insensitive one; among equals the first in
 * document order, the way headings resolve.
 *
 * A group's members are the nodes whose boxes lie entirely inside its box,
 * which is what a group MEANS in JSON Canvas — there is no membership list
 * to read. Edges come along when both ends do. A `^id` naming a non-group
 * node selects that node alone.
 */
export function selectCanvasFragment(
  canvas: SpatialCanvas,
  fragment: string,
): SpatialCanvas | undefined {
  const wanted = fragment.trim()
  if (wanted.length === 0) return undefined
  const root = wanted.startsWith('^')
    ? canvas.nodes.find((node) => node.id === wanted.slice(1))
    : findGroupByLabel(canvas.nodes, wanted)
  if (root === undefined) return undefined
  const ids = new Set<string>([root.id])
  if (root.type === 'group') {
    for (const node of canvas.nodes) if (node !== root && within(node, root)) ids.add(node.id)
  }
  return {
    ...canvas,
    nodes: canvas.nodes.filter((node) => ids.has(node.id)),
    // A fragment keeps an edge only when BOTH ends are inside it. A free end
    // names nothing to be inside, so an edge carrying one never travels.
    edges: canvas.edges.filter((edge) => {
      const from = endNode(edge.from)
      const to = endNode(edge.to)
      return from !== undefined && to !== undefined && ids.has(from) && ids.has(to)
    }),
  }
}

function findGroupByLabel(nodes: readonly SpatialNode[], label: string): SpatialNode | undefined {
  const groups = nodes.filter((node) => node.type === 'group' && node.label !== undefined)
  return (
    groups.find((node) => node.type === 'group' && node.label?.trim() === label) ??
    groups.find(
      (node) => node.type === 'group' && node.label?.trim().toLowerCase() === label.toLowerCase(),
    )
  )
}

function within(node: SpatialNode, box: SpatialNode): boolean {
  return (
    node.x >= box.x &&
    node.y >= box.y &&
    node.x + node.width <= box.x + box.width &&
    node.y + node.height <= box.y + box.height
  )
}
