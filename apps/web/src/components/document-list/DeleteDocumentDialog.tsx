import type { DocumentKind } from '@kamiazya/whiteboard-model'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog.js'
import { Button } from '../../components/ui/button.js'
import { DESTRUCTIVE_COPY, type DestructiveActionId } from '../../lib/destructive-copy.js'
import { kindNoun } from '../../lib/kind-noun.js'

export interface DeleteDocumentDialogProps {
  /**
   * The document pending deletion, or null when the dialog is closed.
   *
   * `count` makes the subject a NUMBER rather than a name, for a bulk
   * delete. Its absence is the singular case, so no existing caller changes
   * and there is one rule rather than two competing subjects. A count of one
   * never arrives: the panel routes a single selection to the singular
   * confirmation, which can say which document it means.
   */
  pending: { displayName: string; kind?: DocumentKind; count?: number } | null
  busy: boolean
  error: string | null
  /**
   * Which promise this delete makes about the user's data. The dialog builds
   * the sentence itself rather than taking one: a caller that can pass a
   * string is a caller that can write a second copy of it, which is how the
   * browser sentence came to exist in two files. See lib/destructive-copy.ts.
   */
  action: DestructiveActionId
  onCancel: () => void
  onConfirm: () => void
}

// Confirmation for the per-card Delete action both list pages render. The
// dialog stays pinned while the delete is in flight: dismissing mid-request
// would let the user re-open and fire a second delete before the first
// settles (same rule as the version-restore dialog).
export function DeleteDocumentDialog({
  pending,
  busy,
  error,
  action,
  onCancel,
  onConfirm,
}: DeleteDocumentDialogProps) {
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && busy) return
        if (!open) onCancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {pending === null
              ? 'Delete canvas?'
              : pending.count === undefined
                ? `Delete "${pending.displayName}"?`
                : `Delete ${pending.count} documents?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {/* A bulk delete spans kinds, so the noun cannot come from one
                document's kind the way the singular subject's does. */}
            {DESTRUCTIVE_COPY[action](
              pending?.count === undefined ? kindNoun(pending?.kind) : 'documents',
            )}
            {error && <span className="mt-2 block text-destructive">{error}</span>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          {/* Not AlertDialogAction: it closes on click, but the dialog must
              stay open (pinned) until the async delete settles. */}
          <Button type="button" variant="destructive" disabled={busy} onClick={onConfirm}>
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
