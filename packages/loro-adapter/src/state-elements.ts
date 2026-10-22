import type { LoroDoc } from 'loro-crdt'

/**
 * The size of a document's state, in elements: one per character, map entry
 * or list element. Read off the oplog, so it holds only for a FRESH copy
 * (`projectWorkspaceDocument`'s output), whose oplog is its state.
 *
 * The one unit a promote's version judging is charged in, so the keeper that
 * charges it and the sender that fits under it count the same thing.
 */
export function stateElementCount(content: LoroDoc): number {
  let total = 0
  for (const count of content.oplogVersion().toJSON().values()) total += count
  return total
}
