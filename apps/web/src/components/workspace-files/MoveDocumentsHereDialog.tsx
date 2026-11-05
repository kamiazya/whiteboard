import { parentOfPath } from '@kamiazya/whiteboard-model'
import { useEffect, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { documentLabel } from '../../lib/document-label.js'
import { type FolderNames, folderDisplayName, folderTrail } from '../../lib/folder-names.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js'
import { DialogActions, ErrorLine } from './FolderDialogParts.js'

/** Where a document stands now, as each folder on the way is called. */
function whereItIs(entry: WorkspaceDocumentEntry, names: FolderNames): string {
  const folder = parentOfPath(entry.path)
  return folder === '' ? folderDisplayName('') : folderTrail(folder, names).join(' / ')
}

function DocumentChoices({
  documents,
  names,
  chosen,
  onToggle,
}: {
  documents: readonly WorkspaceDocumentEntry[]
  names: FolderNames
  chosen: ReadonlySet<string>
  onToggle: (path: string) => void
}) {
  if (documents.length === 0) {
    return <p className="text-muted-foreground text-sm">There are no other documents to move.</p>
  }
  return (
    <fieldset className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
      <legend className="sr-only">Documents</legend>
      {documents.map((entry) => (
        <label
          key={entry.documentId}
          className="hover:bg-accent flex items-center gap-2 rounded px-2 py-1.5 text-sm pointer-coarse:min-h-11"
        >
          <input
            type="checkbox"
            checked={chosen.has(entry.path)}
            onChange={() => onToggle(entry.path)}
            className="size-4 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">{documentLabel(entry, 'leaf')}</span>
          <span className="text-muted-foreground max-w-[45%] shrink-0 truncate text-xs">
            {whereItIs(entry, names)}
          </span>
        </label>
      ))}
    </fieldset>
  )
}

interface MoveDocumentsHereDialogProps {
  /** The folder documents are gathered into, or null when the dialog is closed. */
  folder: string | null
  /** Every document in the workspace; the ones already in `folder` are not offered. */
  documents: readonly WorkspaceDocumentEntry[]
  names: FolderNames
  busy: boolean
  /** Shown verbatim — the keeper names the path that collided. */
  error: string | null
  onCancel: () => void
  /** Where focus goes once the dialog has closed: a handler that does not prevent the event leaves Radix's default (the opener). */
  onCloseAutoFocus: (event: Event) => void
  onMove: (folder: string, entries: readonly WorkspaceDocumentEntry[]) => void | Promise<void>
}

/**
 * The way an existing document reaches a folder from INSIDE it. A folder made
 * with "New folder" stands empty and is not kept once left, so without this the
 * only way to file a document into it was to leave — which lost it.
 */
export function MoveDocumentsHereDialog(props: MoveDocumentsHereDialogProps) {
  const { folder, documents, names, busy, error, onCancel, onMove, onCloseAutoFocus } = props
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => setChosen(new Set()), [folder])
  const offered = documents.filter(
    (entry) => folder !== null && parentOfPath(entry.path) !== folder,
  )
  const toggle = (path: string) =>
    setChosen((before) => {
      const next = new Set(before)
      if (!next.delete(path)) next.add(path)
      return next
    })

  return (
    <Dialog open={folder !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            const picked = offered.filter((entry) => chosen.has(entry.path))
            if (folder !== null && picked.length > 0) void onMove(folder, picked)
          }}
        >
          <DialogHeader>
            <DialogTitle>Move documents here</DialogTitle>
            <DialogDescription>
              Choose what goes into “{folder === null ? '' : folderDisplayName(folder, names)}”.
              Their links and history come with them.
            </DialogDescription>
          </DialogHeader>
          <DocumentChoices documents={offered} names={names} chosen={chosen} onToggle={toggle} />
          <ErrorLine message={error} />
          <DialogActions
            cancelLabel="Cancel"
            onCancel={onCancel}
            submitLabel="Move here"
            busy={busy || chosen.size === 0}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
