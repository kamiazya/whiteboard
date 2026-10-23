import { DialogFooter } from '../ui/dialog.js'

const CANCEL_CLASS = 'rounded-md border px-3 py-1.5 text-sm hover:bg-accent'
const PRIMARY_CLASS =
  'bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm disabled:opacity-50'

/** A refusal worded beside the field it concerns; nothing when there is none. */
export function ErrorLine({ message }: { message: string | null }) {
  if (message === null) return null
  return (
    <p role="alert" className="text-destructive text-sm">
      {message}
    </p>
  )
}

/** The footer of a folder dialog: a way out, and (when there is one) the way on. */
export function DialogActions({
  cancelLabel,
  onCancel,
  submitLabel,
  busy = false,
}: {
  cancelLabel: string
  onCancel: () => void
  /** Absent for a dialog whose only action is picking an option. */
  submitLabel?: string
  busy?: boolean
}) {
  return (
    <DialogFooter>
      <button type="button" onClick={onCancel} className={CANCEL_CLASS}>
        {cancelLabel}
      </button>
      {submitLabel !== undefined && (
        <button type="submit" disabled={busy} className={PRIMARY_CLASS}>
          {submitLabel}
        </button>
      )}
    </DialogFooter>
  )
}
