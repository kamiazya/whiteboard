import type { SpatialCanvas } from '@kamiazya/whiteboard-model'

/** Strict bbox intersection — flush-touching edges are NOT overlap. */
function overlapsAny(
  candidate: SpatialCanvas['nodes'][number],
  block: readonly SpatialCanvas['nodes'][number][],
): boolean {
  return block.some(
    (member) =>
      candidate.x < member.x + member.width &&
      member.x < candidate.x + candidate.width &&
      candidate.y < member.y + member.height &&
      member.y < candidate.y + candidate.height,
  )
}

/**
 * Step the block over the nearest OVERLAPPING non-member above its topmost
 * member (tldraw semantics, user feedback 2026-08-09): hopping over a node the
 * selection does not visually overlap changes nothing on screen and reads as
 * the shortcut "not working". No overlapping node above → the block is already
 * visually on top of its pile → no-op. (Index loops, not findLast — the
 * tsconfig lib target predates es2023.)
 */
function forwardInsertIndex(
  canvas: SpatialCanvas,
  members: ReadonlySet<string>,
  block: SpatialCanvas['nodes'],
  rest: SpatialCanvas['nodes'],
): number | undefined {
  let top = -1
  for (let i = canvas.nodes.length - 1; i >= 0; i--) {
    if (members.has(canvas.nodes[i].id)) {
      top = i
      break
    }
  }
  const over = canvas.nodes
    .slice(top + 1)
    .find((node) => !members.has(node.id) && overlapsAny(node, block))
  return over === undefined ? undefined : rest.indexOf(over) + 1
}

/** Mirror: step under the nearest overlapping non-member below the bottom member. */
function backwardInsertIndex(
  canvas: SpatialCanvas,
  members: ReadonlySet<string>,
  block: SpatialCanvas['nodes'],
  rest: SpatialCanvas['nodes'],
): number | undefined {
  const bottom = canvas.nodes.findIndex((node) => members.has(node.id))
  for (let i = bottom - 1; i >= 0; i--) {
    const node = canvas.nodes[i]
    if (!members.has(node.id) && overlapsAny(node, block)) return rest.indexOf(node)
  }
  return undefined
}

/** Where the block lands, or `undefined` when the placement moves nothing. */
function reorderInsertIndex(
  placement: 'forward' | 'backward' | 'front' | 'back',
  canvas: SpatialCanvas,
  members: ReadonlySet<string>,
  block: SpatialCanvas['nodes'],
  rest: SpatialCanvas['nodes'],
): number | undefined {
  if (placement === 'front') return rest.length
  if (placement === 'back') return 0
  return placement === 'forward'
    ? forwardInsertIndex(canvas, members, block, rest)
    : backwardInsertIndex(canvas, members, block, rest)
}

export function reorderNodes(
  canvas: SpatialCanvas,
  ids: readonly string[],
  placement: 'forward' | 'backward' | 'front' | 'back',
): SpatialCanvas {
  const members = new Set(ids)
  const block = canvas.nodes.filter((node) => members.has(node.id))
  if (block.length === 0) return canvas
  const rest = canvas.nodes.filter((node) => !members.has(node.id))

  const insertAt = reorderInsertIndex(placement, canvas, members, block, rest)
  if (insertAt === undefined) return canvas

  const next = [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)]
  // No-op permutations return the input so callers can cheaply detect "did
  // anything move" (and undo history stays free of empty steps).
  if (next.every((node, index) => node === canvas.nodes[index])) return canvas
  return { ...canvas, nodes: next }
}
