// The browser keeper's half of the markdown size limit: the daemon refuses a
// body past `MARKDOWN_MAX_CHARS` on its sync routes, and this keeper refuses to
// persist one, so a document cannot hold a body one keeper would refuse.
import { documentContainers, MARKDOWN_BODY_KEY } from '@kamiazya/whiteboard-loro-adapter'
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { decodeImportBlobMeta, type LoroDoc } from 'loro-crdt'

/** Operations in `update` that `record` does not hold yet — each inserted character is one. */
function newOperations(record: LoroDoc, update: Uint8Array): number {
  const meta = decodeImportBlobMeta(update, false)
  const start = meta.partialStartVersionVector.toJSON()
  const held = record.oplogVersion().toJSON()
  let count = 0
  for (const [peer, end] of meta.partialEndVersionVector.toJSON()) {
    count += Math.max(0, end - Math.max(start.get(peer) ?? 0, held.get(peer) ?? 0))
  }
  return count
}

function bodyLength(record: LoroDoc, documentId: string): number {
  return documentContainers(record, documentId).getText(MARKDOWN_BODY_KEY).length
}

/**
 * The length `documentId`'s body would have after `update`, when that is past
 * the limit and longer than it is now; `null` when the update may be taken.
 *
 * Free for the edit a person types: a body can grow by at most two UTF-16
 * units per new operation, so an update that cannot reach the limit is
 * answered from the version vectors alone. Only one that might is tried, on a
 * fork, so a refusal leaves `record` exactly as it was. An update bringing
 * more new operations than the limit allows is refused untried: applying one
 * insert that long costs seconds of this tab's time, and it could only fit by
 * deleting nearly as much in the same breath.
 */
export function overfilledBody(
  record: LoroDoc,
  documentId: string,
  update: Uint8Array,
): number | null {
  const before = bodyLength(record, documentId)
  const added = newOperations(record, update)
  if (before + 2 * added <= MARKDOWN_MAX_CHARS) return null
  if (added > MARKDOWN_MAX_CHARS) return before + added
  const scratch = record.fork()
  scratch.import(update)
  const after = bodyLength(scratch, documentId)
  return after > MARKDOWN_MAX_CHARS && after > before ? after : null
}
