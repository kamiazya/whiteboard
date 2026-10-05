/**
 * Which document ids a browser workspace record already accounts for.
 *
 * Its own module rather than the fold's, because three readers hold the rule
 * and only one of them is the fold: the index's fallback listing and the
 * backend's placement ask it too, and a test that replaces the fold must not
 * take the rule away from them with it.
 */
import { readTrashEntries, readWorkspaceNodes } from '@kamiazya/whiteboard-loro-adapter'
import type { LoroDoc } from 'loro-crdt'

/**
 * Every document id the workspace record answers for: a node in its tree, or
 * an entry in its trash. A legacy row naming one of these is done, and an id
 * in here is never placed again.
 */
export function documentIdsInRecord(workspace: LoroDoc): Set<string> {
  const ids = new Set(readTrashEntries(workspace).map((entry) => entry.documentId))
  for (const node of readWorkspaceNodes(workspace)) {
    if (node.type === 'document') ids.add(node.meta.documentId)
  }
  return ids
}
