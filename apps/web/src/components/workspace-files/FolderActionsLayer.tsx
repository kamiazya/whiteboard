import { FolderPlus, Pencil } from 'lucide-react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { hasCoarsePointer } from '../../lib/platform.js'
import { ContextMenu } from '../ui/ContextMenu.js'
import { ErrorLine } from './FolderDialogParts.js'
import { FolderNameDialog } from './FolderNameDialog.js'
import { folderOf, foldersOf, leafOf } from './folder-moves.js'
import { MoveToFolderDialog } from './MoveToFolderDialog.js'

export type FolderDialog = { readonly kind: 'rename' | 'subfolder'; readonly folder: string }
export interface FolderMenu {
  readonly folder: string
  readonly x: number
  readonly y: number
}

function FolderMenuView({
  menu,
  onRename,
  onSubfolder,
  onClose,
}: {
  menu: FolderMenu
  onRename: () => void
  onSubfolder: () => void
  onClose: () => void
}) {
  // The root has no name of its own to change.
  const rename =
    menu.folder === '' ? [] : [{ label: 'Rename…', icon: <Pencil />, onSelect: onRename }]
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      label="Folder actions"
      title={menu.folder === '' ? 'Workspace' : leafOf(menu.folder)}
      items={[...rename, { label: 'New subfolder…', icon: <FolderPlus />, onSelect: onSubfolder }]}
      onClose={onClose}
      variant={hasCoarsePointer() ? 'sheet' : 'list'}
    />
  )
}

/** The folder dialog's wording and the folder its name will sit in, by what it was opened for. */
function nameDialogCopy(dialog: FolderDialog | null) {
  if (dialog?.kind === 'rename') {
    return {
      title: 'Rename folder',
      description: 'Everything in it moves with the new name; links and history are kept.',
      initialName: leafOf(dialog.folder),
      parent: folderOf(dialog.folder),
      submitLabel: 'Rename',
    }
  }
  return {
    title: 'New subfolder',
    description:
      'A folder exists while a document is in it. Open it, then add or move a document in.',
    initialName: '',
    parent: dialog?.folder ?? '',
    submitLabel: 'Open folder',
  }
}

/** The folder dialog, worded by what it was opened for; closed when `dialog` is null. */
function NameDialog({
  dialog,
  busy,
  error,
  onCancel,
  onSubmitName,
}: {
  dialog: FolderDialog | null
  busy: boolean
  error: string | null
  onCancel: () => void
  onSubmitName: (dialog: FolderDialog, name: string) => void | Promise<void>
}) {
  return (
    <FolderNameDialog
      open={dialog !== null}
      {...nameDialogCopy(dialog)}
      busy={busy}
      error={error}
      onCancel={onCancel}
      onSubmit={(name) => dialog !== null && onSubmitName(dialog, name)}
    />
  )
}

/**
 * The polite line that says a move landed, and the refusal of a drop (no
 * dialog is open to word it).
 *
 * No explicit aria-live: Radix hides everything outside an open modal except
 * the subtree of a [aria-live] element, which would leave the panel's own
 * alerts exposed behind the dialog.
 */
function StatusLines({ announcement, refusal }: { announcement: string; refusal: string | null }) {
  return (
    <>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <ErrorLine message={refusal} />
    </>
  )
}

interface FolderActionsLayerProps {
  documents: readonly WorkspaceDocumentEntry[] | null
  announcement: string
  moving: WorkspaceDocumentEntry | null
  menu: FolderMenu | null
  dialog: FolderDialog | null
  busy: boolean
  error: string | null
  onCancel: () => void
  onMoveTo: (entry: WorkspaceDocumentEntry, folder: string) => void | Promise<void>
  onSubmitName: (dialog: FolderDialog, name: string) => void | Promise<void>
  onMenuChoice: (kind: FolderDialog['kind'], folder: string) => void
  onCloseMenu: () => void
}

/**
 * Everything the folder actions put on screen: the move picker, the folder
 * dialog, the folder's own menu and the status lines.
 */
export function FolderActionsLayer(props: FolderActionsLayerProps) {
  const { documents, announcement, moving, menu, dialog, busy, error } = props
  const { onCancel, onMoveTo, onSubmitName, onMenuChoice, onCloseMenu } = props
  const destinations =
    moving === null
      ? []
      : ['', ...foldersOf(documents ?? [])].filter((each) => each !== folderOf(moving.path))

  return (
    <>
      <StatusLines
        announcement={announcement}
        refusal={moving === null && dialog === null ? error : null}
      />
      <MoveToFolderDialog
        document={moving}
        folders={destinations}
        busy={busy}
        error={error}
        onCancel={onCancel}
        onPick={(folder) => moving !== null && onMoveTo(moving, folder)}
      />
      <NameDialog
        dialog={dialog}
        busy={busy}
        error={error}
        onCancel={onCancel}
        onSubmitName={onSubmitName}
      />
      {menu !== null && (
        <FolderMenuView
          menu={menu}
          onRename={() => onMenuChoice('rename', menu.folder)}
          onSubfolder={() => onMenuChoice('subfolder', menu.folder)}
          onClose={onCloseMenu}
        />
      )}
    </>
  )
}
