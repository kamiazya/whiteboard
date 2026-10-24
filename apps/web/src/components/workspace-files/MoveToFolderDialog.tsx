import { Folder } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { documentLabel } from '../../lib/document-label.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js'
import { documentPathRefusal } from './document-path-refusal.js'
import { DialogActions, ErrorLine } from './FolderDialogParts.js'
import { folderLabel, joinPath, leafOf, typedFolderPath } from './folder-moves.js'

const NEW_FOLDER = 'New folder…'

/**
 * Roving focus over `count` options: one tab stop, the arrows, Home and End
 * move it (wrapping), as a listbox does.
 */
function useRovingFocus(count: number) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const [active, setActive] = useState(0)
  const focusOption = (index: number) => {
    const next = (index + count) % count
    setActive(next)
    refs.current[next]?.focus()
  }
  const targets: Record<string, number> = {
    ArrowDown: active + 1,
    ArrowUp: active - 1,
    Home: 0,
    End: count - 1,
  }
  const onKeyDown = (event: KeyboardEvent) => {
    const target = targets[event.key]
    if (target === undefined) return
    event.preventDefault()
    focusOption(target)
  }
  return { active, refs, onKeyDown }
}

/**
 * The folders as a listbox of buttons, with "New folder…" last. Not a
 * `<select>`: the last row opens a second step, which a native menu cannot
 * hold.
 */
function FolderOptions({
  folders,
  busy,
  onPick,
  onNewFolder,
}: {
  folders: readonly string[]
  busy: boolean
  onPick: (folder: string) => void
  onNewFolder: () => void
}) {
  const labels = [...folders.map(folderLabel), NEW_FOLDER]
  const { active, refs, onKeyDown } = useRovingFocus(labels.length)

  return (
    <div
      role="listbox"
      aria-label="Folders"
      onKeyDown={onKeyDown}
      className="flex max-h-64 flex-col gap-0.5 overflow-y-auto"
    >
      {labels.map((label, index) => {
        const isNew = index === folders.length
        return (
          <button
            key={label}
            ref={(element) => {
              refs.current[index] = element
            }}
            type="button"
            role="option"
            aria-selected={index === active}
            tabIndex={index === active ? 0 : -1}
            disabled={busy}
            onClick={() => (isNew ? onNewFolder() : onPick(folders[index] ?? ''))}
            className="hover:bg-accent focus-visible:bg-accent flex items-center gap-2 rounded px-2 py-1.5 pointer-coarse:py-3 text-left text-sm"
          >
            {!isNew && <Folder aria-hidden="true" className="size-4 shrink-0" />}
            <span className="truncate">{label}</span>
          </button>
        )
      })}
    </div>
  )
}

function NewFolderField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label htmlFor="move-new-folder-name">Folder name</label>
      <input
        // This step replaces the list inside an already-open dialog, so the
        // dialog's own focus-on-open never runs for it.
        // biome-ignore lint/a11y/noAutofocus: the step exists to ask this one question
        autoFocus
        id="move-new-folder-name"
        aria-describedby="move-new-folder-hint"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded border px-2 py-1"
      />
      <span id="move-new-folder-hint" className="text-muted-foreground text-xs">
        Use “/” for a folder inside a folder.
      </span>
    </div>
  )
}

/**
 * Naming a folder that does not exist yet. The destination is held to the
 * path grammar with the document's own last segment on the end, because that
 * is the path the keeper will be asked for.
 */
function NewFolderForm({
  document,
  busy,
  error,
  onBack,
  onPick,
}: {
  document: WorkspaceDocumentEntry
  busy: boolean
  error: string | null
  onBack: () => void
  onPick: (folder: string) => void
}) {
  const [name, setName] = useState('')
  const [issue, setIssue] = useState<string | null>(null)
  const submit = () => {
    const folder = typedFolderPath(name)
    if (folder === '') return
    const refusal = documentPathRefusal(joinPath(folder, leafOf(document.path)))
    setIssue(refusal)
    if (refusal === null) onPick(folder)
  }

  return (
    <form
      className="flex flex-col gap-2 py-2"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <NewFolderField value={name} onChange={setName} />
      <ErrorLine message={issue ?? error} />
      <DialogActions cancelLabel="Back" onCancel={onBack} submitLabel="Move" busy={busy} />
    </form>
  )
}

function MoveHeader({ document }: { document: WorkspaceDocumentEntry | null }) {
  return (
    <DialogHeader>
      <DialogTitle>Move to folder</DialogTitle>
      <DialogDescription>
        Where should “{document === null ? '' : documentLabel(document, 'leaf')}” go? Its links and
        history come with it.
      </DialogDescription>
    </DialogHeader>
  )
}

/**
 * The picker behind "Move to folder…". A pointer path (drag a card onto a
 * folder) exists, but this is the one a touch or keyboard user has, so it is
 * complete without the other.
 *
 * `folders` already excludes where the document sits — choosing it would be
 * a move that moves nothing.
 */
export function MoveToFolderDialog({
  document,
  folders,
  busy,
  error,
  onCancel,
  onPick,
}: {
  /** The document being moved, or null when the dialog is closed. */
  document: WorkspaceDocumentEntry | null
  /** Destination folders, `''` being the workspace root. */
  folders: readonly string[]
  busy: boolean
  /** Shown verbatim — the keeper names the path that collided. */
  error: string | null
  onCancel: () => void
  onPick: (folder: string) => void
}) {
  const [naming, setNaming] = useState(false)
  // A different document starts at the list again.
  useEffect(() => setNaming(false), [document])

  return (
    <Dialog open={document !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="sm:max-w-sm">
        <MoveHeader document={document} />
        {naming && document !== null ? (
          <NewFolderForm
            document={document}
            busy={busy}
            error={error}
            onBack={() => setNaming(false)}
            onPick={onPick}
          />
        ) : (
          <>
            <FolderOptions
              folders={folders}
              busy={busy}
              onPick={onPick}
              onNewFolder={() => setNaming(true)}
            />
            <ErrorLine message={error} />
            <DialogActions cancelLabel="Cancel" onCancel={onCancel} />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
