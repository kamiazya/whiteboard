import { useCallback, useState } from 'react'
import type { TrashRow } from '../../lib/files-source.js'
import { PurgeTrashEntryDialog } from './PurgeTrashEntryDialog.js'

export interface PurgeTrashEntryControlProps {
  row: TrashRow
  purge: (documentId: string) => Promise<void>
  /** The trash read is stale now — the entry left it, or was never there. */
  onSettled: () => void
  disabled: boolean
}

/**
 * "Delete permanently" for one trash row: the button and the confirmation it
 * opens, with the request's own pending and failure state.
 *
 * Owned per row rather than by the section because nothing else reads it, and
 * the section's own state stays what restore needs.
 */
export function PurgeTrashEntryControl({
  row,
  purge,
  onSettled,
  disabled,
}: Readonly<PurgeTrashEntryControlProps>) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await purge(row.documentId)
      setOpen(false)
    } catch {
      // The dialog stays open with the line, so a refusal is read where the
      // choice was made. The trash is re-read either way: the usual refusal
      // is an entry another tab already purged, and the row is stale.
      setError('Could not delete this document.')
    } finally {
      setBusy(false)
      onSettled()
    }
  }, [purge, row.documentId, onSettled])

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
        className="text-destructive hover:bg-destructive/10 shrink-0 rounded border px-2 py-0.5 text-xs"
      >
        Delete permanently
      </button>
      <PurgeTrashEntryDialog
        pending={open ? row.path : null}
        busy={busy}
        error={error}
        onCancel={() => setOpen(false)}
        onConfirm={() => void confirm()}
      />
    </>
  )
}
