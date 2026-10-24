import { folderNameRefusal } from '@kamiazya/whiteboard-model'
import { type RefObject, useCallback, useEffect, useMemo, useState } from 'react'
import { displayNameTakenMessage } from '../../lib/display-name-taken.js'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import type { WorkspaceFilesSource } from '../../lib/files-source.js'
import { isFolderNameTaken, newFolderSegmentIn, planNestedFolder } from '../../lib/folder-names.js'
import { useAnnouncer } from '../annotations/announcer.js'
import { FolderActionsLayer, type FolderDialog, type FolderMenu } from './FolderActionsLayer.js'
import type { FolderActions } from './folder-actions.js'
import { useFolderMoves } from './use-folder-moves.js'
import { type FolderNamesState, useFolderNames } from './use-folder-names.js'

/**
 * What the folder surfaces ask of the panel through context: a drop moves,
 * a right-click opens the folder's menu at a root-local point (ContextMenu's
 * x/y contract, like the card menu's).
 */
function useFolderSurfaceActions(
  documents: readonly WorkspaceDocumentEntry[] | null,
  moveInto: (entry: WorkspaceDocumentEntry, folder: string) => Promise<boolean>,
  rootRef: RefObject<HTMLElement | null>,
  setMenu: (menu: FolderMenu) => void,
): FolderActions {
  return useMemo(
    () => ({
      dropInto: (folder, documentPath) => {
        const entry = documents?.find((each) => each.path === documentPath)
        if (entry !== undefined) void moveInto(entry, folder)
      },
      openFolderMenu: (folder, clientX, clientY) => {
        const rect = rootRef.current?.getBoundingClientRect()
        setMenu({ folder, x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) })
      },
    }),
    [documents, moveInto, rootRef, setMenu],
  )
}

type Moves = ReturnType<typeof useFolderMoves>

/** Every address a new folder may not take: the documents' and the folders' known here. */
function takenPaths(
  documents: readonly WorkspaceDocumentEntry[] | null,
  folderNames: FolderNamesState,
): string[] {
  return [...(documents ?? []).map((entry) => entry.path), ...folderNames.folders]
}

/**
 * Where a folder the dialog names would stand: the folder itself on a rename,
 * the address a new subfolder would be given otherwise.
 */
function namedPath(
  open: FolderDialog,
  name: string,
  documents: readonly WorkspaceDocumentEntry[] | null,
  folderNames: FolderNamesState,
): string {
  return open.kind === 'rename'
    ? open.folder
    : newFolderSegmentIn(open.folder, name, takenPaths(documents, folderNames))
}

/**
 * Why the folder dialog's name cannot be used, before anything is sent: the
 * one folder-name rule every keeper holds, then a name a sibling folder
 * already shows, worded as the keeper words it.
 */
function folderDialogRefusal(
  open: FolderDialog,
  name: string,
  documents: readonly WorkspaceDocumentEntry[] | null,
  folderNames: FolderNamesState,
): string | null {
  const rule = folderNameRefusal(name)
  if (rule !== null) return rule
  const path = namedPath(open, name, documents, folderNames)
  const target = { path, name: name.trim() }
  return isFolderNameTaken(folderNames.folders, folderNames.names, target)
    ? displayNameTakenMessage('folder', path, target.name)
    : null
}

/** What the layer asks before a folder is named or made: the refusal, and a typed folder's plan. */
function namingChecks(
  documents: readonly WorkspaceDocumentEntry[] | null,
  folderNames: FolderNamesState,
) {
  return {
    refuseName: (open: FolderDialog, name: string) =>
      folderDialogRefusal(open, name, documents, folderNames),
    planNewFolder: (typed: string) =>
      planNestedFolder(typed, {
        folders: folderNames.folders,
        names: folderNames.names,
        taken: takenPaths(documents, folderNames),
      }),
  }
}

/** What the layer's dialogs and menu do when answered, in terms of the moves and the open dialogs. */
function layerHandlers({
  documents,
  folderNames,
  moveInto,
  renameFolder,
  goToFolder,
  setError,
  setMoving,
  setDialog,
}: Pick<Moves, 'moveInto' | 'renameFolder' | 'setError'> & {
  documents: readonly WorkspaceDocumentEntry[] | null
  folderNames: FolderNamesState
  goToFolder: (folder: string) => void
  setMoving: (entry: WorkspaceDocumentEntry | null) => void
  setDialog: (dialog: FolderDialog | null) => void
}) {
  return {
    onCancel: () => {
      setMoving(null)
      setDialog(null)
      setError(null)
    },
    onMoveTo: async (
      entry: WorkspaceDocumentEntry,
      folder: string,
      created: readonly { readonly path: string; readonly name: string }[] = [],
    ) => {
      // Named before the move, so the flush finds them once the document lands.
      for (const each of created) folderNames.remember(each.path, each.name)
      if (await moveInto(entry, folder)) setMoving(null)
    },
    onSubmitName: async (open: FolderDialog, name: string) => {
      if (open.kind === 'subfolder') {
        const path = namedPath(open, name, documents, folderNames)
        folderNames.remember(path, name)
        setDialog(null)
        goToFolder(path)
      } else if (await renameFolder(open.folder, name)) setDialog(null)
    },
    ...namingChecks(documents, folderNames),
    onMenuChoice: (kind: FolderDialog['kind'], folder: string) => {
      setError(null)
      setDialog({ kind, folder })
    },
  }
}

/** The card menu's way into the move picker, clearing the last refusal. */
function useMovePickerOpener(
  setError: (error: null) => void,
  setMoving: (entry: WorkspaceDocumentEntry) => void,
) {
  return useCallback(
    (entry: WorkspaceDocumentEntry) => {
      setError(null)
      setMoving(entry)
    },
    [setError, setMoving],
  )
}

/** Which surface is open, each naming a path — cleared when the workspace changes. */
function useOpenSurfaces(source: unknown, clearError: (error: null) => void) {
  const [moving, setMoving] = useState<WorkspaceDocumentEntry | null>(null)
  const [menu, setMenu] = useState<FolderMenu | null>(null)
  const [dialog, setDialog] = useState<FolderDialog | null>(null)
  // SCOPE RESET — a path of the departed workspace handed to the new keeper.
  useEffect(() => {
    setMoving(null)
    setMenu(null)
    setDialog(null)
    clearError(null)
  }, [source, clearError])
  return { moving, setMoving, menu, setMenu, dialog, setDialog }
}

interface FolderActionsDeps {
  source: WorkspaceFilesSource
  documents: readonly WorkspaceDocumentEntry[] | null
  rootRef: RefObject<HTMLElement | null>
  /** The panel's own move: it follows the previewed document and re-reads. */
  moveDocument: (entry: WorkspaceDocumentEntry, newPath: string) => Promise<void>
  goToFolder: (folder: string) => void
}

/**
 * Moving documents between folders and renaming folders, for the panel: the
 * pointer (drop on a folder) and menu (Move to folder…, a folder's own menu)
 * paths share one move and one announcement, so they cannot say different
 * things. `actions` is what the folder-shaped surfaces read from context;
 * `layer` is what the panel renders once; `openMovePicker` is the card
 * menu's entry.
 *
 * There is no stored folder to create — a new folder exists once something
 * is moved into it, and "New subfolder…" only opens the (empty) place, its
 * name held until a document lands there (`useFolderNames`).
 */
export function useFolderActions({
  source,
  documents,
  rootRef,
  moveDocument,
  goToFolder,
}: FolderActionsDeps) {
  const { announcement, announce } = useAnnouncer()
  const folderNames = useFolderNames(source, documents)
  const { busy, error, setError, moveInto, renameFolder } = useFolderMoves({
    moveDocument,
    announce,
    folderNames,
  })
  const { moving, setMoving, menu, setMenu, dialog, setDialog } = useOpenSurfaces(source, setError)

  const actions = useFolderSurfaceActions(documents, moveInto, rootRef, setMenu)
  const openMovePicker = useMovePickerOpener(setError, setMoving)
  const handlers = layerHandlers({
    documents,
    folderNames,
    moveInto,
    renameFolder,
    goToFolder,
    setError,
    setMoving,
    setDialog,
  })

  const layer = (
    <FolderActionsLayer
      folderNames={folderNames}
      announcement={announcement}
      moving={moving}
      menu={menu}
      dialog={dialog}
      busy={busy}
      error={error}
      onCloseMenu={() => setMenu(null)}
      {...handlers}
    />
  )

  return { actions, names: folderNames.names, openMovePicker, layer }
}
