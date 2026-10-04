import { DESTRUCTIVE_COPY } from '../../lib/destructive-copy.js'
import { PinnedConfirmDialog } from '../ui/pinned-confirm-dialog.js'

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
 */
export function PurgeTrashEntryDialog({
  pending,
  busy,
  error,
  onCancel,
  onConfirm,
}: Readonly<PurgeTrashEntryDialogProps>) {
  return (
    <PinnedConfirmDialog
      open={pending !== null}
      busy={busy}
      title="Delete permanently?"
      description={DESTRUCTIVE_COPY['purge-trash-entry'](pending ?? '')}
      error={error}
      confirmLabel="Delete permanently"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
