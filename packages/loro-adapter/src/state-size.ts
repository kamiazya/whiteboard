import type { LoroDoc } from 'loro-crdt'

/**
 * The size of a document's state, in the unit a promote's version judging is
 * charged in: one per map entry and list element, and one per character of
 * every string — a text container's, and every string inside a value a map
 * holds whole.
 *
 * Read off the state rather than the oplog, because the oplog undercounts a
 * board by everything that matters: a node is ONE map entry holding its
 * whole object, so twenty nodes at the node-text limit were twenty ops while
 * judging them reads 160 K characters. Walking the value counts what the
 * judge reads.
 *
 * The one counter both sides use, so the keeper that charges a judgement and
 * the sender that fits under its budget measure the same thing.
 */
export function stateSize(content: LoroDoc): number {
  return sizeOf(content.toJSON())
}

function sizeOf(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) {
    let total = value.length
    for (const item of value) total += sizeOf(item)
    return total
  }
  if (value !== null && typeof value === 'object') {
    let total = 0
    for (const item of Object.values(value)) total += 1 + sizeOf(item)
    return total
  }
  return 0
}
