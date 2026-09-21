/**
 * The document-page kebab's own rows, and everything they need: Duplicate,
 * Delete, the confirmation the second one opens, and the alert row either
 * one reports a refusal through.
 *
 * One bundle rather than four pieces threaded through a page, because they
 * are one affordance: the rows, the dialog they open, the focus the dialog
 * hands back to the kebab, and the alert line are useless apart. A page asks
 * for it and spreads the answer into its `slots`.
 *
 * The verbs are passed IN: what deleting a document means is the keeper's
 * business (the daemon's is one DELETE and a list refresh; the browser's is a
 * cleanup with its own terminal state), and what a refusal SAYS is
 * `destructive-copy.ts`'s. This holds only the shape that is the same either
 * way — which is why `copyId` is a parameter rather than a constant.
 */
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { Copy, Trash2 } from 'lucide-react'
import { type ReactNode, useRef } from 'react'
import { DeleteDocumentDialog } from '../components/document-editor/DeleteDocumentDialog.js'
import { DropdownMenuItem } from '../components/ui/dropdown-menu.js'
import type { DestructiveActionId } from '../lib/destructive-copy.js'
import { useDeleteDocument } from './use-delete-document.js'
import { useDuplicateDocument } from './use-duplicate-document.js'

export interface UseDocumentActionsOptions {
  /** The document on screen, or undefined while the list has not named one. */
  readonly documentId: string | undefined
  readonly documentKind: DocumentKind
  /** Resolves with the copy, or rejects; this bundle watches only the refusal. */
  readonly duplicateDocument: () => Promise<unknown>
  /** Resolves once the document is gone, or rejects. */
  readonly deleteDocument: () => Promise<void>
  /** Which keeper's delete sentence the confirmation shows. */
  readonly deleteCopyId: Extract<
    DestructiveActionId,
    'delete-document-browser' | 'delete-document-daemon'
  >
}

export interface DocumentActionSlots {
  readonly menuTriggerRef: React.RefObject<HTMLButtonElement | null>
  readonly menuItems: ReactNode
  readonly afterMenu: ReactNode
  /** Absent when neither verb has a refusal to show. */
  readonly rowAlerts?: ReactNode
}

export function useDocumentActions({
  documentId,
  documentKind,
  duplicateDocument,
  deleteDocument,
  deleteCopyId,
}: UseDocumentActionsOptions): DocumentActionSlots {
  // The document on screen NOW, for an async handler that started under a
  // different one: a page switches documents in place rather than remounting,
  // so a closure can only answer with the render it was made in.
  const currentDocumentIdRef = useRef<string | null>(null)
  currentDocumentIdRef.current = documentId ?? null
  const documentOpsButtonRef = useRef<HTMLButtonElement | null>(null)

  const { isDuplicating, duplicateError, handleDuplicate } = useDuplicateDocument({
    documentId: documentId ?? null,
    currentDocumentIdRef,
    documentKind,
    duplicateDocument,
  })
  const { confirmDelete, setConfirmDelete, deleteError, handleDelete } = useDeleteDocument({
    documentId,
    documentKind,
    deleteDocument,
  })

  return {
    menuTriggerRef: documentOpsButtonRef,
    menuItems: (
      <>
        <DropdownMenuItem disabled={isDuplicating} onSelect={() => void handleDuplicate()}>
          <Copy aria-hidden="true" className="size-3.5" />
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          onSelect={() => setConfirmDelete(true)}
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
          Delete
        </DropdownMenuItem>
      </>
    ),
    afterMenu: (
      <DeleteDocumentDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        documentKind={documentKind}
        copyId={deleteCopyId}
        triggerRef={documentOpsButtonRef}
        onConfirm={() => void handleDelete()}
      />
    ),
    ...(duplicateError === null && deleteError === null
      ? {}
      : {
          rowAlerts: (
            <div role="alert" aria-live="assertive" className="text-destructive text-xs">
              {duplicateError ?? deleteError}
            </div>
          ),
        }),
  }
}
