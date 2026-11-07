/**
 * Why a stored document could not be read back.
 *
 * - `unsupported-version` — the record is intact but was written in a shape
 *   this build does not know. The data is not damaged; the reader is old.
 * - `malformed` — the record is there and does not parse as anything.
 * - `retired-envelope` — the record is intact, in an envelope a build this
 *   keeper shipped once wrote and no longer reads. Never lifted and never
 *   deleted: the opposite of `malformed`, which is damage.
 *
 * Discriminated rather than one opaque failure because the two mean opposite
 * things to a user: one says "update the app", the other says "this document
 * is damaged". A caller that folds them into "not found" tells someone their
 * work is missing when it is sitting on disk.
 */
export type StoredDocumentUnreadableCode = 'unsupported-version' | 'malformed' | 'retired-envelope'

export class StoredDocumentUnreadableError extends Error {
  readonly code: StoredDocumentUnreadableCode

  constructor(code: StoredDocumentUnreadableCode, message: string) {
    super(message)
    this.name = 'StoredDocumentUnreadableError'
    this.code = code
  }
}

export function isStoredDocumentUnreadableError(
  error: unknown,
): error is StoredDocumentUnreadableError {
  return error instanceof StoredDocumentUnreadableError
}
