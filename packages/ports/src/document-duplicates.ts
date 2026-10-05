import { documentPathSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { DocumentEntry, DocumentIndex } from './document-index.js'

export const duplicateDocumentInputSchema = z
  .object({ workspaceId: workspaceIdSchema, path: documentPathSchema })
  .strict()
export type DuplicateDocumentInput = z.infer<typeof duplicateDocumentInputSchema>

/**
 * Copying a document, as ONE keeper-side operation.
 *
 * The keeper decides where the copy goes and what it is called (model's
 * `deriveCopyPath` / `deriveCopyName`: beside the source, "(copy N)") inside
 * the same serialised write that creates it, so two duplicates racing on one
 * source cannot pick the same path, and no reader ever sees a copy that is
 * empty or unnamed.
 *
 * A CAPABILITY rather than a method of `DocumentIndex`, for the reason
 * `DocumentTrash` is: it copies CONTENT, which a tree-backed index holds and
 * the legacy row-backed index does not.
 */
export interface DocumentDuplicates {
  /**
   * The new document's entry. Rejects with `DocumentNotFoundError` for a path
   * no document holds, `DocumentPathContestedError` for one more than one
   * holds, `NoRoomForCopyError` when the source's folder leaves no room for a
   * copy beside it, and `WorkspaceNotFoundError` for a workspace the index
   * does not hold.
   */
  duplicateDocument(input: DuplicateDocumentInput): Promise<DocumentEntry>
}

/** Structural for the cross-realm reason `hasDocumentPins` is. */
export function hasDocumentDuplicates(
  index: DocumentIndex,
): index is DocumentIndex & DocumentDuplicates {
  return 'duplicateDocument' in index && typeof index.duplicateDocument === 'function'
}

/**
 * Thrown when the source's folder is so deep that no copy segment fits beside
 * it under the path bound. Placing the copy anywhere else would be a placement
 * nobody asked for, so the duplicate is refused instead.
 */
export class NoRoomForCopyError extends Error {
  constructor(readonly path: string) {
    super(`There is no room beside "${path}" for a copy: its folder's path is too long.`)
    this.name = 'NoRoomForCopyError'
  }
}
