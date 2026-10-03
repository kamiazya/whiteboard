import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { DocumentIndex, ListDocumentsInput } from './document-index.js'

const setDocumentPinnedInputSchema = z
  .object({ workspaceId: workspaceIdSchema, documentId: documentIdSchema, pinned: z.boolean() })
  .strict()
export type SetDocumentPinnedInput = z.infer<typeof setDocumentPinnedInputSchema>

/**
 * A workspace's pinned documents: the ordered list a user keeps at the top of
 * their file list.
 *
 * A CAPABILITY of the index that holds the workspace record, not a method of
 * `DocumentIndex`: the pinned list is a container in that record, so every
 * tree-backed index has it, while the legacy row-backed index has no home for
 * one. Callers holding a plain `DocumentIndex` ask `hasDocumentPins` first, so
 * a keeper that cannot pin says so by omission instead of by failing.
 *
 * Both are keyed by `documentId`, never by path: a pin follows its document
 * through a move, which a path-keyed list could not do without being rewritten
 * by every rename.
 */
export interface DocumentPins {
  /**
   * The live documents that are pinned, in the order they were pinned. A
   * pinned id whose document is gone is not listed. Rejects with
   * `WorkspaceNotFoundError` for a workspace the index does not hold, as
   * `listDocuments` does.
   */
  listPinnedDocuments(input: ListDocumentsInput): Promise<string[]>
  /**
   * Pin or unpin one document. Idempotent: re-pinning keeps the position the
   * document already has, and unpinning an unpinned document is done.
   * Rejects with `DocumentNotFoundError` for a document the workspace does
   * not hold.
   */
  setDocumentPinned(input: SetDocumentPinnedInput): Promise<void>
}

/**
 * Structural rather than `instanceof`, for the cross-realm reason
 * `isWorkspaceNotFoundError` is: a decorator or a test double has the methods
 * without being the class.
 */
export function hasDocumentPins(index: DocumentIndex): index is DocumentIndex & DocumentPins {
  return (
    'listPinnedDocuments' in index &&
    typeof index.listPinnedDocuments === 'function' &&
    'setDocumentPinned' in index &&
    typeof index.setDocumentPinned === 'function'
  )
}
