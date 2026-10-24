import { documentPathSchema, folderNameSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { DocumentIndex, ListDocumentsInput } from './document-index.js'

/**
 * One named folder as a listing answers it. Read loosely — any non-empty
 * path and name — for the reason every reader is: a name some other writer
 * stored must still list rather than fail the listing.
 */
const folderNameEntrySchema = z
  .object({ path: z.string().min(1), name: z.string().min(1) })
  .strict()
export type FolderNameEntry = z.infer<typeof folderNameEntrySchema>

/**
 * A folder display-name write: `name` absent clears it. The name is held to
 * `folderNameSchema` (non-blank, no `/`, bounded); a folder's PATH is never
 * changed by it — the address is fixed when the folder is made.
 */
export const setFolderNameInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    path: documentPathSchema,
    name: folderNameSchema.optional(),
  })
  .strict()
export type SetFolderNameInput = z.infer<typeof setFolderNameInputSchema>

/**
 * A workspace's folder display names: what a person reads for a folder,
 * apart from its segment, which stays the address.
 *
 * A CAPABILITY of the index that holds the workspace record, as
 * `DocumentPins` is: a folder is a node of that record's tree, while the
 * legacy row-backed index has no folder to name. Callers holding a plain
 * `DocumentIndex` ask `hasDocumentFolders` first.
 */
export interface DocumentFolders {
  /**
   * Every named folder, once per path, in `listDocuments`' path order. An
   * unnamed folder is not listed: a reader shows its segment. Rejects with
   * `WorkspaceNotFoundError` for a workspace the index does not hold.
   */
  listFolderNames(input: ListDocumentsInput): Promise<FolderNameEntry[]>
  /**
   * Names, or with no `name` clears, the folder at `path`. Rejects with
   * `DocumentNotFoundError` when no folder stands there — a document used
   * as a folder included, since it has no folder of its own to name — and
   * with `DisplayNameTakenError` when another folder directly under the
   * same parent already shows the name. The folder's own name is no
   * duplicate; a document beside it of the same name is none either.
   */
  setFolderName(input: SetFolderNameInput): Promise<void>
}

/**
 * Structural rather than `instanceof`, for the cross-realm reason
 * `hasDocumentPins` is.
 */
export function hasDocumentFolders(index: DocumentIndex): index is DocumentIndex & DocumentFolders {
  return (
    'listFolderNames' in index &&
    typeof index.listFolderNames === 'function' &&
    'setFolderName' in index &&
    typeof index.setFolderName === 'function'
  )
}
