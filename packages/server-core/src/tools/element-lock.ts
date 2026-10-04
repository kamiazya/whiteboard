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
