import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'

export interface DeleteDocumentDialogProps {
  // The canvas pending deletion, or null when the dialog is closed.
  pending: { displayName: string } | null
  busy: boolean
  error: string | null
  description: string
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
  description,
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
            {pending ? `Delete "${pending.displayName}"?` : 'Delete canvas?'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {description}
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
