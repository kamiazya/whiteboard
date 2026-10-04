import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { DocumentIndex } from './document-index.js'

const trashEntryInputSchema = z
  .object({ workspaceId: workspaceIdSchema, documentId: documentIdSchema })
  .strict()
export type TrashEntryInput = z.infer<typeof trashEntryInputSchema>

/**
 * What the trash shows about a deleted document. The evacuated bytes' address
 * is the index's business and never crosses this port.
 */
const trashEntrySummarySchema = z
  .object({
    documentId: documentIdSchema,
    path: z.string().min(1),
    deletedAt: z.number().int().nonnegative(),
  })
  .strict()
type TrashEntrySummary = z.infer<typeof trashEntrySummarySchema>

/**
 * A workspace's trash: what `deleteDocument` evacuated, brought back or
 * destroyed.
 *
 * A CAPABILITY of the index that evacuates, not a method of `DocumentIndex`,
 * for the reason `DocumentPins` is: the trash rows live in the workspace
 * record and the bytes in a blob store the tree-backed index is constructed
 * with, while the legacy row-backed index deletes outright. Callers holding a
 * plain `DocumentIndex` ask `hasDocumentTrash` first.
 */
export interface DocumentTrash {
  /**
   * What this workspace could still bring back, newest first. Rejects with
   * `WorkspaceNotFoundError` for a workspace the index does not hold.
   */
  listTrash(input: { workspaceId: string }): Promise<TrashEntrySummary[]>
  /**
   * Brings a deleted document back under the `documentId` it had. `null` when
   * there is nothing to bring back: never trashed, or the evacuated bytes are
   * gone.
   */
  restoreDocument(input: TrashEntryInput): Promise<{ documentId: string; path: string } | null>
  /**
   * Destroys one trashed document for good — its row and its evacuated bytes —
   * so it can no longer be restored and the files only it named stop being
   * kept for it. Only a document that is IN the trash: a live one is never
   * reached by this, whatever id it is given.
   *
   * Answers whether it removed anything; `false` for an id the trash does not
   * hold (never trashed, already purged, another workspace's), which is how a
   * double click or a second tab reads. A row whose bytes are already gone is
   * still removed — it is the one way to clear a damaged entry. Rejects with
   * `WorkspaceNotFoundError` for a workspace the index does not hold.
   */
  purgeTrashEntry(input: TrashEntryInput): Promise<boolean>
}

/** Structural for the cross-realm reason `hasDocumentPins` is. */
export function hasDocumentTrash(index: DocumentIndex): index is DocumentIndex & DocumentTrash {
  return (
    'listTrash' in index &&
    typeof index.listTrash === 'function' &&
    'restoreDocument' in index &&
    typeof index.restoreDocument === 'function' &&
    'purgeTrashEntry' in index &&
    typeof index.purgeTrashEntry === 'function'
  )
}
