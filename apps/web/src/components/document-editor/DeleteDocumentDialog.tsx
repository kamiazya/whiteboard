import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { RefObject } from 'react'
import { DESTRUCTIVE_COPY, type DestructiveActionId } from '../../lib/destructive-copy.js'
import { kindNoun } from '../../lib/kind-noun.js'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog.js'

export interface DeleteDocumentDialogProps {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** Only for the wording: "Delete this note?" against "…this canvas?". */
  readonly documentKind: DocumentKind
  /**
   * Which sentence this keeper owes. A browser workspace keeps no versions,
   * so its copy does not warn about losing them; the daemon's does. Taking
   * the id rather than the built string keeps `destructive-copy-surface`'s
   * scan pointed at the one place the wording lives.
   */
  readonly copyId: Extract<
    DestructiveActionId,
    'delete-document-browser' | 'delete-document-daemon'
  >
  /** The kebab to hand focus back to — see `onCloseAutoFocus` below. */
  readonly triggerRef: RefObject<HTMLButtonElement | null>
  readonly onConfirm: () => void
}

export function DeleteDocumentDialog({
  open,
  onOpenChange,
  documentKind,
  copyId,
  triggerRef,
  onConfirm,
}: DeleteDocumentDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        // The menu item that opened this dialog unmounted with the menu;
        // default close-focus would fall to <body>, so hand it to the kebab.
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          triggerRef.current?.focus()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this {kindNoun(documentKind)}?</AlertDialogTitle>
          <AlertDialogDescription>
            {DESTRUCTIVE_COPY[copyId](kindNoun(documentKind))}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90"
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
