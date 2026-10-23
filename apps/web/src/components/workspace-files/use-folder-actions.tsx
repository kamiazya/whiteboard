import { type RefObject, useCallback, useEffect, useMemo, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { useAnnouncer } from '../annotations/announcer.js'
import { FolderActionsLayer, type FolderDialog, type FolderMenu } from './FolderActionsLayer.js'
import type { FolderActions } from './folder-actions.js'
import { joinPath } from './folder-moves.js'
import { useFolderMoves } from './use-folder-moves.js'

type FolderMovesDeps = Parameters<typeof useFolderMoves>[0]

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

/** What the layer's dialogs and menu do when answered, in terms of the moves and the open dialogs. */
function layerHandlers({
  moveInto,
  renameFolder,
  goToFolder,
  setError,
  setMoving,
  setDialog,
}: Pick<Moves, 'moveInto' | 'renameFolder' | 'setError'> & {
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
    onMoveTo: async (entry: WorkspaceDocumentEntry, folder: string) => {
      if (await moveInto(entry, folder)) setMoving(null)
    },
    onSubmitName: async (open: FolderDialog, name: string) => {
      if (open.kind === 'subfolder') {
        setDialog(null)
        goToFolder(joinPath(open.folder, name))
      } else if (await renameFolder(open.folder, name)) setDialog(null)
    },
    onMenuChoice: (kind: FolderDialog['kind'], folder: string) => {
      setError(null)
      setDialog({ kind, folder })
    },
  }
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

/**
 * Moving documents between folders and renaming folders, for the panel: the
 * pointer (drop on a folder) and menu (Move to folder…, a folder's own menu)
 * paths share one move and one announcement, so they cannot say different
 * things. `actions` is what the folder-shaped surfaces read from context;
 * `layer` is what the panel renders once; `openMovePicker` is the card
 * menu's entry.
 *
 * There is no stored folder to create — a new folder exists once something
 * is moved into it, and "New subfolder…" only opens the (empty) place.
 */
export function useFolderActions({
  documents,
  rootRef,
  ...deps
}: {
  documents: readonly WorkspaceDocumentEntry[] | null
  rootRef: RefObject<HTMLElement | null>
} & Omit<FolderMovesDeps, 'announce'>) {
  const { announcement, announce } = useAnnouncer()
  const { busy, error, setError, moveInto, renameFolder } = useFolderMoves({ ...deps, announce })
  const { moving, setMoving, menu, setMenu, dialog, setDialog } = useOpenSurfaces(
    deps.source,
    setError,
  )

  const actions = useFolderSurfaceActions(documents, moveInto, rootRef, setMenu)
  const openMovePicker = useCallback(
    (entry: WorkspaceDocumentEntry) => {
      setError(null)
      setMoving(entry)
    },
    [setError],
  )
  const handlers = layerHandlers({
    moveInto,
    renameFolder,
    goToFolder: deps.goToFolder,
    setError,
    setMoving,
    setDialog,
  })

  const layer = (
    <FolderActionsLayer
      documents={documents}
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

  return { actions, openMovePicker, layer }
}
