import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { useRef } from 'react'
import { DESTRUCTIVE_COPY, type DestructiveActionId } from '../../lib/destructive-copy.js'
import { kindNoun } from '../../lib/kind-noun.js'
import { PinnedConfirmDialog } from '../ui/pinned-confirm-dialog.js'

export interface DeleteDocumentsDialogProps {
  /**
   * The document pending deletion, or null when the dialog is closed.
   *
   * `count` makes the subject a NUMBER rather than a name, for a bulk
   * delete. Its absence is the singular case, so no existing caller changes
   * and there is one rule rather than two competing subjects. A count of one
   * never arrives: the panel routes a single selection to the singular
   * confirmation, which can say which document it means.
   *
   * `path` is the single document's, so a dismissal can hand focus back to its
   * card: the menu item that opened the dialog is gone by then, and with no
   * Trigger Radix would land on <body>.
   */
  pending: {
    displayName: string
    kind?: DocumentKind
    count?: number
    path?: string
    /** One of the documents is the workspace's stored tag library, whose colours go with it. */
    tagLibrary?: boolean
  } | null
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

/** Said before the tag library goes, since nothing about an empty-looking note says what it keeps. */
const TAG_LIBRARY_WARNING =
  "It is this workspace's tag library: deleting it removes every tag colour set in this workspace."

// Confirmation for the per-card Delete action both list pages render.
export function DeleteDocumentsDialog({
  pending,
  busy,
  error,
  action,
  onCancel,
  onConfirm,
}: DeleteDocumentsDialogProps) {
  // The dialog closes by `pending` going null, so the path is read from the
  // last request it showed.
  const lastPath = useRef<string | undefined>(undefined)
  if (pending !== null) lastPath.current = pending.path
  return (
    <PinnedConfirmDialog
      open={pending !== null}
      onCloseAutoFocus={(event) => {
        const path = lastPath.current
        if (path === undefined) return
        const card = document.querySelector<HTMLElement>(`[data-doc-path="${CSS.escape(path)}"]`)
        card?.focus()
        if (card !== null && document.activeElement === card) event.preventDefault()
      }}
      busy={busy}
      title={
        pending === null
          ? 'Delete canvas?'
          : pending.count === undefined
            ? `Delete "${pending.displayName}"?`
            : `Delete ${pending.count} documents?`
      }
      // A bulk delete spans kinds, so the noun cannot come from one
      // document's kind the way the singular subject's does.
      description={`${DESTRUCTIVE_COPY[action](
        pending?.count === undefined ? kindNoun(pending?.kind) : 'documents',
      )}${pending?.tagLibrary === true ? ` ${TAG_LIBRARY_WARNING}` : ''}`}
      error={error}
      confirmLabel="Delete"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
