import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'

/** Two boxes share a row when their tops sit within this of each other. */
const SAME_ROW_PX = 24

/**
 * A box this batch touched whose connections along its own row all lie to
 * one side of it, two or more of them: the edge to the farther one has to
 * pass the nearer, and the router pays with a crossing or a loop under
 * both. Measured on the lane's layered board, the same box mid-row reads
 * crossings 1 -> 0, bends 2 -> 0, reversals 1 -> 0 and a quarter less ink;
 * a sentence saying so in the skill was read by six trials and followed by
 * none, so the answer to the call says it instead.
 */
export function fanOutNotes(canvas: SpatialCanvas, touched: ReadonlySet<string>): string[] {
  const byId = new Map(canvas.nodes.map((node) => [node.id, node]))
  const notes: string[] = []
  for (const hub of canvas.nodes) {
    if (hub.type === 'group' || !touched.has(hub.id)) continue
    const alongRow = canvas.edges
      .map((edge) =>
        edge.fromNode === hub.id ? edge.toNode : edge.toNode === hub.id ? edge.fromNode : undefined,
      )
      .map((id) => (id === undefined ? undefined : byId.get(id)))
      .filter(
        (node): node is SpatialNode =>
          node !== undefined && node.type !== 'group' && Math.abs(node.y - hub.y) < SAME_ROW_PX,
      )
    if (alongRow.length < 2) continue
    const right = alongRow.filter((node) => node.x >= hub.x + hub.width)
    const left = alongRow.filter((node) => node.x + node.width <= hub.x)
    const side =
      right.length === alongRow.length ? right : left.length === alongRow.length ? left : undefined
    if (side === undefined) continue
    const byDistance = [...side].sort((a, b) => Math.abs(a.x - hub.x) - Math.abs(b.x - hub.x))
    const near = byDistance[0] as SpatialNode
    const far = byDistance[byDistance.length - 1] as SpatialNode
    notes.push(
      `"${hub.id}" fans out along its row past "${near.id}" to "${far.id}"; in the middle of its row, or in a row of its own, its edges have somewhere to go`,
    )
  }
  return notes
}
