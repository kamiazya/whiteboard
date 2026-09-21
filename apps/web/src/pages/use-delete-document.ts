/**
 * Delete-this-document, as a document page's own screen state: whether the
 * confirmation is standing, the refusal it is showing, and the handler that
 * asks the keeper.
 *
 * The keeper's `deleteDocument()` rejects on failure rather than carrying its
 * own error (see the daemon controller), so the PAGE owns the surface — the
 * same split `use-duplicate-document.ts` already makes for the other verb.
 *
 * Everything here NAMES A DOCUMENT, and a document page switches in place
 * rather than remounting, so none of it may outlive the document it is about.
 * `confirmDelete` is the one that bites: it is a bare boolean while
 * `deleteDocument()` acts on whatever the controller currently holds, so a
 * dialog opened on one document and confirmed after a switch deletes the
 * OTHER — measured on the browser keeper, where the document that ARRIVED
 * while the dialog stood was the one that went. SCOPE RESET — see
 * scoped-screen-state.test.ts, whose DaemonDocumentPage scan reads this file
 * too: the state moved HERE, not away.
 */
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { useEffect, useState } from 'react'
import { kindNoun } from '../lib/kind-noun.js'

export interface DeleteDocumentState {
  readonly confirmDelete: boolean
  readonly setConfirmDelete: (open: boolean) => void
  readonly deleteError: string | null
  readonly handleDelete: () => Promise<void>
}

export interface UseDeleteDocumentOptions {
  /** The document on screen, or undefined while the list has not named one. */
  readonly documentId: string | undefined
  /** Only for the refusal's wording: "Failed to delete <noun>." */
  readonly documentKind: DocumentKind
  /** Rejects on refusal; resolves once the document is gone. */
  readonly deleteDocument: () => Promise<void>
}

export function useDeleteDocument({
  documentId,
  documentKind,
  deleteDocument,
}: UseDeleteDocumentOptions): DeleteDocumentState {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // SCOPE RESET — both name the document the dialog was opened for, and the
  // page switches documents without remounting, so neither may outlive it.
  // Keyed on the same `documentId` the page's other resets watch; see
  // scoped-screen-state.test.ts, which reads this block by that marker.
  useEffect(() => {
    setConfirmDelete(false)
    setDeleteError(null)
  }, [documentId])

  const handleDelete = async (): Promise<void> => {
    // Closed first, so the page is never left with a confirmation standing
    // over a document that is already gone.
    setConfirmDelete(false)
    setDeleteError(null)
    try {
      await deleteDocument()
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : `Failed to delete ${kindNoun(documentKind)}.`,
      )
    }
  }

  return { confirmDelete, setConfirmDelete, deleteError, handleDelete }
}
