import { isStoredDocumentUnreadableError } from '@kamiazya/whiteboard-ports'
import { documentReadFailureMessage } from './document-read-failure.js'

/**
 * The browser keeper's answer to stored data this build does not read.
 *
 * Old stored shapes are not migrated: the code that read them is gone, so a
 * shape this build cannot read is REFUSED by name rather than read as empty.
 * An empty listing over a database that holds documents tells their owner the
 * work is gone; this tells them why it cannot be opened and what to do.
 *
 * Two shapes are refused, and they differ in what the person can still do:
 *
 * - `pre-tree-records`: a workspace whose documents are still the
 *   per-document records builds before the workspace tree wrote. The
 *   database opens, so another workspace in this browser works; only this
 *   one is refused.
 * - `database-version`: the database itself is at a version older than the
 *   one schema this build creates. It cannot be opened at all, so nothing can
 *   be read out of it, and the only way to a working browser keeper is to
 *   clear this site's stored data.
 *
 * The message is the one the page shows. A daemon-kept workspace never reads
 * this storage, so it is unaffected either way, and the message says so.
 */
export type BrowserStorageRefusalReason = 'pre-tree-records' | 'database-version'

const MESSAGES: Record<BrowserStorageRefusalReason, string> = {
  'pre-tree-records':
    'The documents in this workspace were saved in a format this version of the app no longer reads, so they cannot be opened. Start a new workspace to keep working. Workspaces a daemon keeps are not affected.',
  'database-version':
    'This browser’s saved data was written by an older version of the app in a format it no longer reads, so it cannot be opened. To start a new workspace, clear this site’s data in your browser settings. Workspaces a daemon keeps are not affected.',
}

export class BrowserStorageRefusedError extends Error {
  readonly reason: BrowserStorageRefusalReason

  constructor(reason: BrowserStorageRefusalReason, detail?: string) {
    super(MESSAGES[reason])
    this.name = 'BrowserStorageRefusedError'
    this.reason = reason
    if (detail !== undefined) this.cause = detail
  }
}

export function isBrowserStorageRefusedError(err: unknown): err is BrowserStorageRefusedError {
  return err instanceof BrowserStorageRefusedError
}

/**
 * The sentence for a load that threw because the stored data is in a shape
 * this build no longer reads, or `null` for any other failure. Two errors
 * qualify: the keeper's own refusal, and a record in a retired envelope —
 * intact data, so it is named and never offered for deletion.
 */
export function refusalSentence(err: unknown): string | null {
  if (isBrowserStorageRefusedError(err)) return err.message
  if (isStoredDocumentUnreadableError(err) && err.code === 'retired-envelope') {
    return documentReadFailureMessage('retired-stored-shape')
  }
  return null
}
