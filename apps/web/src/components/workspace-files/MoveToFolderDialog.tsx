import { Folder } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { documentLabel } from '../../lib/document-label.js'
import {
  type FolderNames,
  folderDisplayName,
  folderTrail,
  type NestedFolderPlan,
} from '../../lib/folder-names.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js'
import { documentPathRefusal } from './document-path-refusal.js'
import { DialogActions, ErrorLine } from './FolderDialogParts.js'
import { joinPath, leafOf } from './folder-moves.js'

/** The folders a typed new folder makes on its way, each with the name it was given. */
type CreatedFolders = Extract<NestedFolderPlan, { path: string }>['created']

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
 * Each option's words: a folder's whole trail, as each folder on it is called
 * — two folders may share a name under different parents, and the list must
 * tell them apart — then "New folder…".
 */
function optionLabels(folders: readonly string[], names: FolderNames): string[] {
  return [
    ...folders.map((folder) =>
      folder === '' ? folderDisplayName('') : folderTrail(folder, names).join(' / '),
    ),
    NEW_FOLDER,
  ]
}

/**
 * The folders as a listbox of buttons, with "New folder…" last. Not a
 * `<select>`: the last row opens a second step, which a native menu cannot
 * hold.
 */
function FolderOptions({
  folders,
  names,
  busy,
  onPick,
  onNewFolder,
}: {
  folders: readonly string[]
  names: FolderNames
  busy: boolean
  onPick: (folder: string) => void
  onNewFolder: () => void
}) {
  const labels = optionLabels(folders, names)
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
            key={index === folders.length ? NEW_FOLDER : `folder:${folders[index]}`}
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
        Use “/” for a folder inside a folder: “Class/Week 6” makes both.
      </span>
    </div>
  )
}

/**
 * Naming a folder that does not exist yet — "/" nests, each part naming one
 * folder. The plan is refused for a blank part or a name a sibling folder
 * already shows, and then held to the path grammar with the document's own
 * last segment on the end, because that is the path the keeper will be asked
 * for.
 */
function NewFolderForm({
  document,
  busy,
  error,
  planNewFolder,
  onBack,
  onPick,
}: {
  document: WorkspaceDocumentEntry
  busy: boolean
  error: string | null
  planNewFolder: (typed: string) => NestedFolderPlan
  onBack: () => void
  onPick: (folder: string, created: CreatedFolders) => void
}) {
  const [name, setName] = useState('')
  const [issue, setIssue] = useState<string | null>(null)
  const submit = () => {
    const plan = planNewFolder(name)
    if ('refusal' in plan) {
      setIssue(plan.refusal)
      return
    }
    const refusal = documentPathRefusal(joinPath(plan.path, leafOf(document.path)))
    setIssue(refusal)
    if (refusal === null) onPick(plan.path, plan.created)
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

interface MoveToFolderDialogProps {
  /** The document being moved, or null when the dialog is closed. */
  document: WorkspaceDocumentEntry | null
  /** Destination folders, `''` being the workspace root. */
  folders: readonly string[]
  /** What each folder is called. */
  names: FolderNames
  /** What a typed new folder means, or why it is refused. */
  planNewFolder: (typed: string) => NestedFolderPlan
  busy: boolean
  /** Shown verbatim — the keeper names the path that collided. */
  error: string | null
  onCancel: () => void
  /** A folder picked, or one typed — then with the folders it makes on the way. */
  onPick: (folder: string, created?: CreatedFolders) => void
}

/**
 * The picker behind "Move to folder…". A pointer path (drag a card onto a
 * folder) exists, but this is the one a touch or keyboard user has, so it is
 * complete without the other.
 *
 * `folders` already excludes where the document sits — choosing it would be
 * a move that moves nothing.
 */
export function MoveToFolderDialog(props: MoveToFolderDialogProps) {
  const { document, folders, names, planNewFolder, busy, error, onCancel, onPick } = props
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
            planNewFolder={planNewFolder}
            onBack={() => setNaming(false)}
            onPick={onPick}
          />
        ) : (
          <>
            <FolderOptions
              folders={folders}
              names={names}
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
