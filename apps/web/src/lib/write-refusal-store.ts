import type { SyncWriteRefusalCode } from '@kamiazya/whiteboard-daemon-client/api-contracts/sync-write-refusal'
import type { SyncWriteRefusal } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { KEEPER_LIMIT_REASON } from './limit-notice.js'
import { createSubscribers } from './subscribers.js'

/**
 * The last write the open document's keeper refused for good, for the notice
 * that says so above every page.
 *
 * A channel of its own rather than a persistence state: by the time anyone
 * reads it the session has dropped the refused edit for the keeper's state,
 * so the document IS saved again and the save indicator says so — this is
 * what tells the person that what they typed last was not kept, and why.
 */
let refusal: SyncWriteRefusal | null = null
const changed = createSubscribers()

export const subscribeWriteRefusal = changed.subscribe

export function getWriteRefusal(): SyncWriteRefusal | null {
  return refusal
}

export function showWriteRefusal(next: SyncWriteRefusal): void {
  refusal = next
  changed.emit()
}

export function dismissWriteRefusal(): void {
  if (refusal === null) return
  refusal = null
  changed.emit()
}

/** Why the keeper refused, in words about what the person did. */
const WHY: Record<SyncWriteRefusalCode, string> = {
  ...KEEPER_LIMIT_REASON,
  document_name_too_long: 'It would give a document a name longer than a name may be.',
  invalid_path:
    'It would put a document at a path that is too long, or that holds something other than letters, digits and hyphens.',
  container_name_too_long:
    'It would add a comment thread, a proposal or another part of a document under an id longer than one may be.',
  unreadable_document_meta:
    'It would leave documents in this workspace that could not be read, hiding them.',
}

export function writeRefusalReason(refused: SyncWriteRefusal): string {
  if (refused.code !== null) return WHY[refused.code]
  return refused.message === '' ? 'The keeper did not say why.' : refused.message
}
