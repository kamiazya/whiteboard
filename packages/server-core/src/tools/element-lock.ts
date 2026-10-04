/**
 * The sentence every writer refuses a locked node or edge with.
 *
 * A lock is a person's promise that an agent will not change an element, so
 * every tool that can change one refuses it — and says the same thing, because
 * the way out (an unlock op) is what the caller needs and it is the same way
 * out from each of them.
 */
export function lockedDetail(kind: 'node' | 'edge', id: string): string {
  return `${kind} "${id}" is locked; unlock it with ${kind === 'node' ? 'a node.lock' : 'an edge.lock'} op first`
}

/**
 * The refusal for an op that would delete a locked edge as a side effect —
 * removing an endpoint, or leaving it out of a region's membership. A lock
 * covers the element wherever the deletion is routed from, and `consequence`
 * says which route this was.
 */
export function lockedEdgeLossDetail(id: string, consequence: string): string {
  return `edge "${id}" is locked and ${consequence}; unlock it with an edge.lock op first`
}
