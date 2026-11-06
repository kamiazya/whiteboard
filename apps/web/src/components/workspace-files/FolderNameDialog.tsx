import { useId, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js'
import { DialogActions, ErrorLine } from './FolderDialogParts.js'

interface FolderNameDialogProps {
  open: boolean
  title: string
  description: string
  initialName: string
  /** A line under the field saying how a name is read, when it is read specially. */
  hint?: string | undefined
  /**
   * Why a name cannot be used, or null: the folder-name rule and the
   * duplicate check, asked before anything is sent.
   */
  refuse: (name: string) => string | null
  submitLabel: string
  busy: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (name: string) => void
  /** Where focus goes once the dialog has closed: a handler that does not prevent the event leaves Radix's default (the opener). */
  onCloseAutoFocus: (event: Event) => void
}

/** The name field, and the line under it saying how a name is read when it is read specially. */
function NameField({
  value,
  onChange,
  hint,
}: {
  value: string
  onChange: (next: string) => void
  hint: string | undefined
}) {
  const hintId = useId()
  return (
    <>
      <label className="flex flex-col gap-1 text-sm">
        Folder name
        <input
          value={value}
          aria-describedby={hint === undefined ? undefined : hintId}
          onChange={(event) => onChange(event.target.value)}
          className="rounded border px-2 py-1 pointer-coarse:min-h-11"
        />
      </label>
      {hint !== undefined && (
        <span id={hintId} className="text-muted-foreground text-xs">
          {hint}
        </span>
      )}
    </>
  )
}

function FolderNameForm({
  title,
  description,
  initialName,
  hint,
  refuse,
  submitLabel,
  busy,
  error,
  onCancel,
  onSubmit,
}: Omit<FolderNameDialogProps, 'open' | 'onCloseAutoFocus'>) {
  const [name, setName] = useState(initialName)
  const [issue, setIssue] = useState<string | null>(null)

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        const refusal = refuse(name)
        setIssue(refusal)
        if (refusal === null) onSubmit(name.trim())
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2 py-4">
        <NameField value={name} onChange={setName} hint={hint} />
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
 * What is asked for is the folder's display name, never its address, and a
 * refusal is worded here beside the field before the keeper is asked. The form is
 * mounted only while open, so each opening starts from `initialName`, and
 * the dialog's first focusable is the field.
 */
export function FolderNameDialog({
  open,
  onCancel,
  onCloseAutoFocus,
  ...form
}: FolderNameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent className="sm:max-w-sm" onCloseAutoFocus={onCloseAutoFocus}>
        <FolderNameForm {...form} onCancel={onCancel} />
      </DialogContent>
    </Dialog>
  )
}
