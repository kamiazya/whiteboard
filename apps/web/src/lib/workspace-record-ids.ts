/**
 * Which document ids a browser workspace record already accounts for.
 *
 * Its own module rather than the backend's, because a test that replaces the
 * backend must not take the rule away with it.
 */
import { lease, type RecordLease } from '@kamiazya/whiteboard-loro-adapter'
import { z } from 'zod'

// The engine's answers are typed by the reader that produced them; only the
// field this rule reads is named here.
const trashShape = z.custom<Array<{ documentId: string }>>()
const nodesShape = z.custom<Array<{ type: string; meta?: { documentId: string } }>>()

/**
 * Every document id the workspace record answers for: a node in its tree, or
 * an entry in its trash. A legacy row naming one of these is done, and an id
 * in here is never placed again.
 */
export async function documentIdsInRecord(record: RecordLease): Promise<Set<string>> {
  const trash = await lease.read(record, { query: 'trash' }, trashShape)
  const nodes = await lease.read(record, { query: 'nodes' }, nodesShape)
  const ids = new Set(trash.map((entry) => entry.documentId))
  for (const node of nodes) {
    if (node.type === 'document' && node.meta !== undefined) ids.add(node.meta.documentId)
  }
  return ids
}
