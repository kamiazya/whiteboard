import { compareCodeUnit } from '@kamiazya/whiteboard-model'
import { FolderPlus, Pencil } from 'lucide-react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { folderDisplayName, type NestedFolderPlan } from '../../lib/folder-names.js'
import { hasCoarsePointer } from '../../lib/platform.js'
import { ContextMenu } from '../ui/ContextMenu.js'
import { ErrorLine } from './FolderDialogParts.js'
import { FolderNameDialog } from './FolderNameDialog.js'
import { folderOf } from './folder-moves.js'
import { MoveToFolderDialog } from './MoveToFolderDialog.js'
import type { FolderNamesState } from './use-folder-names.js'

export type FolderDialog = { readonly kind: 'rename' | 'subfolder'; readonly folder: string }
export interface FolderMenu {
  readonly folder: string
  readonly x: number
  readonly y: number
}

function FolderMenuView({
  menu,
  title,
  canRename,
  onRename,
  onSubfolder,
  onClose,
}: {
  menu: FolderMenu
  title: string
  /** False for the root, which has no name of its own, and a document used as a folder, which has no folder to name. */
  canRename: boolean
  onRename: () => void
  onSubfolder: () => void
  onClose: () => void
}) {
  const rename = canRename ? [{ label: 'Rename…', icon: <Pencil />, onSelect: onRename }] : []
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      label="Folder actions"
      title={title}
      items={[...rename, { label: 'New subfolder…', icon: <FolderPlus />, onSelect: onSubfolder }]}
      onClose={onClose}
      variant={hasCoarsePointer() ? 'sheet' : 'list'}
    />
  )
}

/** The folder dialog's wording, by what it was opened for. */
function nameDialogCopy(dialog: FolderDialog | null, names: FolderNamesState['names']) {
  if (dialog?.kind === 'rename') {
    return {
      title: 'Rename folder',
      description: 'Only its name changes. Its address, and every link into it, stay as they are.',
      initialName: folderDisplayName(dialog.folder, names),
      submitLabel: 'Rename',
    }
  }
  return {
    title: 'New subfolder',
    description:
      'A folder exists while a document is in it. Open it, then add or move a document in.',
    initialName: '',
    submitLabel: 'Open folder',
  }
}

/** The folder dialog, worded by what it was opened for; closed when `dialog` is null. */
function NameDialog({
  dialog,
  names,
  busy,
  error,
  refuseName,
  onCancel,
  onSubmitName,
}: {
  dialog: FolderDialog | null
  names: FolderNamesState['names']
  busy: boolean
  error: string | null
  refuseName: (dialog: FolderDialog, name: string) => string | null
  onCancel: () => void
  onSubmitName: (dialog: FolderDialog, name: string) => void | Promise<void>
}) {
  return (
    <FolderNameDialog
      open={dialog !== null}
      {...nameDialogCopy(dialog, names)}
      refuse={(name) => (dialog === null ? null : refuseName(dialog, name))}
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
  folderNames: FolderNamesState
  announcement: string
  moving: WorkspaceDocumentEntry | null
  menu: FolderMenu | null
  dialog: FolderDialog | null
  busy: boolean
  error: string | null
  onCancel: () => void
  onMoveTo: (
    entry: WorkspaceDocumentEntry,
    folder: string,
    created?: readonly { readonly path: string; readonly name: string }[],
  ) => void | Promise<void>
  onSubmitName: (dialog: FolderDialog, name: string) => void | Promise<void>
  refuseName: (dialog: FolderDialog, name: string) => string | null
  planNewFolder: (typed: string) => NestedFolderPlan
  onMenuChoice: (kind: FolderDialog['kind'], folder: string) => void
  onCloseMenu: () => void
}

/**
 * Everything the folder actions put on screen: the move picker, the folder
 * dialog, the folder's own menu and the status lines.
 */
export function FolderActionsLayer(props: FolderActionsLayerProps) {
  const { folderNames, announcement, moving, menu, dialog, busy, error } = props
  const { onCancel, onMoveTo, onSubmitName, refuseName, planNewFolder, onMenuChoice, onCloseMenu } =
    props
  const destinations =
    moving === null
      ? []
      : ['', ...[...folderNames.folders].sort(compareCodeUnit)].filter(
          (each) => each !== folderOf(moving.path),
        )

  return (
    <>
      <StatusLines
        announcement={announcement}
        refusal={moving === null && dialog === null ? error : null}
      />
      <MoveToFolderDialog
        document={moving}
        folders={destinations}
        names={folderNames.names}
        planNewFolder={planNewFolder}
        busy={busy}
        error={error}
        onCancel={onCancel}
        onPick={(folder, created) => moving !== null && onMoveTo(moving, folder, created)}
      />
      <NameDialog
        dialog={dialog}
        names={folderNames.names}
        refuseName={refuseName}
        busy={busy}
        error={error}
        onCancel={onCancel}
        onSubmitName={onSubmitName}
      />
      {menu !== null && (
        <FolderMenuView
          menu={menu}
          title={folderDisplayName(menu.folder, folderNames.names)}
          canRename={folderNames.canRename(menu.folder)}
          onRename={() => onMenuChoice('rename', menu.folder)}
          onSubfolder={() => onMenuChoice('subfolder', menu.folder)}
          onClose={onCloseMenu}
        />
      )}
    </>
  )
}
