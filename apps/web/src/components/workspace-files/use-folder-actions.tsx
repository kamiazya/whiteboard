import { folderNameRefusal } from '@kamiazya/whiteboard-model'
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import type { WorkspaceFilesSource } from '../../lib/files-source.js'
import {
  folderNameTakenMessage,
  folderShowingName,
  planFolderToCreate,
  planNestedFolder,
} from '../../lib/folder-names.js'
import { useAnnouncer } from '../annotations/announcer.js'
import { FolderActionsLayer, type FolderDialog, type FolderMenu } from './FolderActionsLayer.js'
import type { FolderActions } from './folder-actions.js'
import { documentLanding, focusLanding, folderLanding, refocus } from './folder-landing.js'
import { pathInFolder } from './folder-moves.js'
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
  setGathering: (folder: string) => void,
  rename: Pick<FolderActions, 'renameFolder' | 'canRename'>,
): FolderActions {
  const { renameFolder, canRename } = rename
  return useMemo(
    () => ({
      renameFolder,
      canRename,
      dropInto: (folder, documentPath) => {
        const entry = documents?.find((each) => each.path === documentPath)
        if (entry !== undefined) void moveInto(entry, folder)
      },
      openFolderMenu: (folder, clientX, clientY) => {
        const rect = rootRef.current?.getBoundingClientRect()
        setMenu({ folder, x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) })
      },
      gatherInto: setGathering,
    }),
    [documents, moveInto, rootRef, setMenu, setGathering, renameFolder, canRename],
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

/** What New folder typed under `parent` makes: "/" nests, as in Move to folder. */
function planSubfolder(
  parent: string,
  typed: string,
  documents: readonly WorkspaceDocumentEntry[] | null,
  folderNames: FolderNamesState,
) {
  return planFolderToCreate(typed, {
    folders: folderNames.folders,
    names: folderNames.names,
    taken: takenPaths(documents, folderNames),
    from: parent,
  })
}

/**
 * Why the folder dialog's name cannot be used, before anything is sent: a
 * new folder's plan refuses what any of its parts cannot be called; a rename
 * holds the one folder-name rule every keeper holds, then a name a sibling
 * folder already shows, worded as the keeper words it.
 */
function folderDialogRefusal(
  open: FolderDialog,
  name: string,
  documents: readonly WorkspaceDocumentEntry[] | null,
  folderNames: FolderNamesState,
): string | null {
  if (open.kind === 'subfolder') {
    const plan = planSubfolder(open.folder, name, documents, folderNames)
    return 'refusal' in plan ? plan.refusal : null
  }
  const rule = folderNameRefusal(name)
  if (rule !== null) return rule
  const target = { path: open.folder, name: name.trim() }
  const holder = folderShowingName(folderNames.folders, folderNames.names, target)
  return holder === undefined ? null : folderNameTakenMessage(holder, folderNames.names)
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

type HandlerDeps = Pick<Moves, 'moveInto' | 'renameFolder' | 'setError'> & {
  documents: readonly WorkspaceDocumentEntry[] | null
  folderNames: FolderNamesState
  goToFolder: (folder: string) => void
  setMoving: (entry: WorkspaceDocumentEntry | null) => void
  setDialog: (dialog: FolderDialog | null) => void
  setGathering: (folder: string | null) => void
  announce: (text: string) => void
  /** Where focus goes when the dialog now closing has gone. */
  landOn: (selectors: readonly string[]) => void
  /** Note what is opening a dialog about the object `about` finds, for a dismissal to return to. */
  openedFrom: (about: readonly string[]) => void
}

/** The two move dialogs answered: documents gathered into a folder, one sent to a folder. */
function moveHandlers({ folderNames, moveInto, setMoving, setGathering, landOn }: HandlerDeps) {
  return {
    // One move at a time, stopping at the first refusal so the dialog can
    // word it with the rest still chosen. The folder's pending name needs
    // nothing here: it is written once the listing shows a document in it.
    onGather: async (folder: string, entries: readonly WorkspaceDocumentEntry[]) => {
      for (const entry of entries) if (!(await moveInto(entry, folder))) return
      const [first] = entries
      if (first !== undefined) landOn(documentLanding(pathInFolder(first.path, folder)))
      setGathering(null)
    },
    onMoveTo: async (
      entry: WorkspaceDocumentEntry,
      folder: string,
      created: readonly { readonly path: string; readonly name: string }[] = [],
    ) => {
      // Named only once the move landed: a refused move makes no folder, and a
      // remembered name would leave one in the picker. The flush finds the
      // names when the listing shows the document there.
      const calledAs = created.find((each) => each.path === folder)?.name
      if (!(await moveInto(entry, folder, calledAs))) return
      for (const each of created) folderNames.remember(each.path, each.name)
      landOn(folderLanding(folder))
      setMoving(null)
    },
  }
}

/** The folder dialog answered: a new folder opened, or a folder renamed. */
function nameHandlers(deps: HandlerDeps) {
  const { documents, folderNames, renameFolder, goToFolder, setDialog, announce, landOn } = deps
  return {
    onSubmitName: async (open: FolderDialog, name: string) => {
      if (open.kind === 'subfolder') {
        const plan = planSubfolder(open.folder, name, documents, folderNames)
        if ('refusal' in plan) return
        for (const each of plan.created) folderNames.remember(each.path, each.name)
        landOn(folderLanding(plan.path))
        setDialog(null)
        goToFolder(plan.path)
        // The route announcer still names the page; this says where in it.
        announce(`In ${plan.created.at(-1)?.name ?? name}, empty`)
      } else if (await renameFolder(open.folder, name)) {
        landOn(folderLanding(open.folder))
        setDialog(null)
      }
    },
    ...namingChecks(documents, folderNames),
  }
}

/** What the layer's dialogs and menu do when answered, in terms of the moves and the open dialogs. */
function layerHandlers(deps: HandlerDeps) {
  const { setMoving, setDialog, setGathering, setError, openedFrom } = deps
  return {
    onCancel: () => {
      setMoving(null)
      setDialog(null)
      setGathering(null)
      setError(null)
    },
    ...moveHandlers(deps),
    ...nameHandlers(deps),
    onMenuChoice: (kind: FolderDialog['kind'], folder: string) => {
      openedFrom(folderLanding(folder))
      setError(null)
      setDialog({ kind, folder })
    },
  }
}

/**
 * Where focus goes once a folder dialog closes: set by the handler that
 * closes it, spent by the dialog's close. A dialog dismissed without an
 * answer goes back where it was opened from — the control itself while it is
 * still on screen, else the object it was about (a menu item that opened it
 * is gone by then). Radix cannot do this: these dialogs have no Trigger, so
 * its own return lands on <body>.
 */
function useDialogLanding(rootRef: RefObject<HTMLElement | null>) {
  const landing = useRef<readonly string[] | null>(null)
  const opener = useRef<{ element: Element | null; about: readonly string[] } | null>(null)
  const landOn = useCallback((selectors: readonly string[]) => {
    landing.current = selectors
  }, [])
  const openedFrom = useCallback((about: readonly string[]) => {
    opener.current = { element: document.activeElement, about }
  }, [])
  const onCloseAutoFocus = useCallback(
    (event: Event) => {
      const selectors = landing.current
      const from = opener.current
      landing.current = null
      opener.current = null
      if (selectors !== null) {
        if (focusLanding(rootRef.current, selectors)) event.preventDefault()
        return
      }
      if (from === null) return
      if (refocus(from.element) || focusLanding(rootRef.current, from.about)) event.preventDefault()
    },
    [rootRef],
  )
  return { landOn, openedFrom, onCloseAutoFocus }
}

/** The card menu's way into the move picker, clearing the last refusal. */
function useMovePickerOpener(
  setError: (error: null) => void,
  setMoving: (entry: WorkspaceDocumentEntry) => void,
  openedFrom: (about: readonly string[]) => void,
) {
  return useCallback(
    (entry: WorkspaceDocumentEntry) => {
      openedFrom(documentLanding(entry.path))
      setError(null)
      setMoving(entry)
    },
    [setError, setMoving, openedFrom],
  )
}

/** The empty folder's "Move documents here…", noting where it was opened from. */
function useGatherOpener(
  openedFrom: (about: readonly string[]) => void,
  setGathering: (folder: string) => void,
) {
  return useCallback(
    (folder: string) => {
      openedFrom(folderLanding(folder))
      setGathering(folder)
    },
    [openedFrom, setGathering],
  )
}

/**
 * A folder's F2: its Rename dialog when it can be renamed here. Read through
 * a ref, since the handlers are rebuilt every render and the surfaces'
 * context would change with them.
 */
function useRenameAsk(
  onMenuChoice: (kind: FolderDialog['kind'], folder: string) => void,
  canRename: (folder: string) => boolean,
): Pick<FolderActions, 'renameFolder' | 'canRename'> {
  const choose = useRef(onMenuChoice)
  choose.current = onMenuChoice
  const renameFolder = useCallback(
    (folder: string) => {
      if (canRename(folder)) choose.current('rename', folder)
    },
    [canRename],
  )
  return useMemo(() => ({ renameFolder, canRename }), [renameFolder, canRename])
}

/** Which surface is open, each naming a path — cleared when the workspace changes. */
function useOpenSurfaces(source: unknown, clearError: (error: null) => void) {
  const [moving, setMoving] = useState<WorkspaceDocumentEntry | null>(null)
  const [menu, setMenu] = useState<FolderMenu | null>(null)
  const [dialog, setDialog] = useState<FolderDialog | null>(null)
  const [gathering, setGathering] = useState<string | null>(null)
  // SCOPE RESET — a path of the departed workspace handed to the new keeper.
  useEffect(() => {
    setMoving(null)
    setMenu(null)
    setDialog(null)
    setGathering(null)
    clearError(null)
  }, [source, clearError])
  return { moving, setMoving, menu, setMenu, dialog, setDialog, gathering, setGathering }
}

interface FolderActionsDeps {
  source: WorkspaceFilesSource
  documents: readonly WorkspaceDocumentEntry[] | null
  rootRef: RefObject<HTMLElement | null>
  /** The panel's own move: it follows the previewed document and re-reads. */
  moveDocument: (entry: WorkspaceDocumentEntry, newPath: string) => Promise<void>
  goToFolder: (folder: string) => void
  /** The workspace's memory scope, which a pending folder name is kept under for this tab. */
  memoryScope?: string | undefined
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
 * is moved into it, and "New folder" only opens the (empty) place, its
 * name held until a document lands there (`useFolderNames`).
 */
export function useFolderActions({
  source,
  documents,
  rootRef,
  moveDocument,
  goToFolder,
  memoryScope,
}: FolderActionsDeps) {
  const { announcement, announce } = useAnnouncer()
  const folderNames = useFolderNames(source, documents, memoryScope)
  const { busy, error, setError, moveInto, renameFolder } = useFolderMoves({
    moveDocument,
    announce,
    folderNames,
  })
  const surfaces = useOpenSurfaces(source, setError)
  const { moving, setMoving, menu, setMenu, dialog, gathering, setGathering } = surfaces
  const { landOn, openedFrom, onCloseAutoFocus } = useDialogLanding(rootRef)
  const gatherFrom = useGatherOpener(openedFrom, setGathering)

  const openMovePicker = useMovePickerOpener(setError, setMoving, openedFrom)
  const handlers = layerHandlers({
    ...surfaces,
    ...{ documents, folderNames, moveInto, renameFolder, goToFolder, setError, announce, landOn },
    openedFrom,
  })
  const rename = useRenameAsk(handlers.onMenuChoice, folderNames.canRename)
  const actions = useFolderSurfaceActions(documents, moveInto, rootRef, setMenu, gatherFrom, rename)

  const layer = (
    <FolderActionsLayer
      folderNames={folderNames}
      documents={documents ?? []}
      gathering={gathering}
      announcement={announcement}
      moving={moving}
      menu={menu}
      dialog={dialog}
      busy={busy}
      error={error ?? folderNames.refusal}
      onCloseMenu={() => setMenu(null)}
      onCloseAutoFocus={onCloseAutoFocus}
      {...handlers}
    />
  )

  const { names, flushInto } = folderNames
  const openNewFolder = (folder: string) => handlers.onMenuChoice('subfolder', folder)
  return { actions, names, flushInto, openMovePicker, openNewFolder, layer }
}
