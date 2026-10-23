import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js'
import { DialogActions, ErrorLine } from './FolderDialogParts.js'
import { folderNameRefusal } from './folder-moves.js'

interface FolderNameDialogProps {
  open: boolean
  title: string
  description: string
  initialName: string
  /** The folder the named one will sit in, for the grammar check. */
  parent: string
  submitLabel: string
  busy: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (name: string) => void
}

function FolderNameForm({
  title,
  description,
  initialName,
  parent,
  submitLabel,
  busy,
  error,
  onCancel,
  onSubmit,
}: Omit<FolderNameDialogProps, 'open'>) {
  const [name, setName] = useState(initialName)
  const [issue, setIssue] = useState<string | null>(null)

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        const refusal = folderNameRefusal(name, parent)
        setIssue(refusal)
        if (refusal === null) onSubmit(name.trim())
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2 py-4">
        <label className="flex flex-col gap-1 text-sm">
          Folder name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="rounded border px-2 py-1"
          />
        </label>
        <ErrorLine message={issue ?? error} />
      </div>
      <DialogActions
        cancelLabel="Cancel"
        onCancel={onCancel}
        submitLabel={submitLabel}
        busy={busy}
      />
    </form>
  )
}

/**
 * One folder name, asked for: the rename of a folder and a new subfolder are
 * the same question with different titles. Enter commits, Escape cancels.
 *
 * The name is one path segment, checked against the path grammar before the
 * keeper is asked, so a refusal is worded here beside the field. The form is
 * mounted only while open, so each opening starts from `initialName`, and
 * the dialog's first focusable is the field.
 */
export function FolderNameDialog({ open, onCancel, ...form }: FolderNameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent className="sm:max-w-sm">
        <FolderNameForm {...form} onCancel={onCancel} />
      </DialogContent>
    </Dialog>
  )
}
