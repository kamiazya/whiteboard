import { DESTRUCTIVE_COPY } from '../../lib/destructive-copy.js'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog.js'
import { Button } from '../ui/button.js'

export interface PurgeTrashEntryDialogProps {
  /** The path of the trashed document pending deletion, or null when closed. */
  pending: string | null
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Confirmation before a trashed document is destroyed for good.
 *
 * Pinned while the request is in flight, like the delete dialogs: dismissing
 * mid-request would let the person re-open it and fire a second purge before
 * the first settles.
 */
export function PurgeTrashEntryDialog({
  pending,
  busy,
  error,
  onCancel,
  onConfirm,
}: PurgeTrashEntryDialogProps) {
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
          <AlertDialogTitle>Delete permanently?</AlertDialogTitle>
          <AlertDialogDescription>
            {DESTRUCTIVE_COPY['purge-trash-entry'](pending ?? '')}
            {error && <span className="mt-2 block text-destructive">{error}</span>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          {/* Not AlertDialogAction: it closes on click, and the dialog must
              stay open until the purge settles. */}
          <Button type="button" variant="destructive" disabled={busy} onClick={onConfirm}>
            Delete permanently
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
