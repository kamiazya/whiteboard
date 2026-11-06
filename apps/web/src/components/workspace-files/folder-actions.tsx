import {
  createContext,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  useContext,
  useMemo,
  useState,
} from 'react'
import { hasCoarsePointer } from '../../lib/platform.js'

/** The custom drag payload: a document's path, which only this panel's targets read. */
const DOCUMENT_DRAG_TYPE = 'application/x-whiteboard-document-path'

/**
 * What the folder-shaped surfaces (cards, tree rows) can do without each one
 * threading three callbacks through the list that holds it. Absent means the
 * host renders no folder actions, so every surface stays inert, not broken.
 */
export interface FolderActions {
  /** A document was dropped on `folder`. */
  readonly dropInto: (folder: string, documentPath: string) => void
  readonly openFolderMenu: (folder: string, clientX: number, clientY: number) => void
  /** Pick existing documents to move into `folder` — the empty folder's way to be kept. */
  readonly gatherInto: (folder: string) => void
  /** Ask for `folder`'s new name; nothing for a folder that cannot be renamed here. */
  readonly renameFolder: (folder: string) => void
  readonly canRename: (folder: string) => boolean
}

export const FolderActionsContext = createContext<FolderActions | undefined>(undefined)

/**
 * Props that make a document card or row draggable to a folder. Not on a
 * coarse pointer: a touch hold is the object menu, and a draggable element
 * would race it for the same gesture — the menu's "Move to folder…" is the
 * touch path.
 */
export function useDocumentDragProps(path: string) {
  const actions = useContext(FolderActionsContext)
  if (actions === undefined || hasCoarsePointer()) return {}
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, path)
      event.dataTransfer.effectAllowed = 'move'
    },
  }
}

function carriesDocument(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(DOCUMENT_DRAG_TYPE)
}

/**
 * A folder's own F2, the rename a document card and a canvas node answer to.
 * Shift+F10 and the Menu key need nothing here: the browser turns them into
 * the `contextmenu` the folder already opens its menu on. An event an inner
 * control already answered is left alone, so a tree item and the button in it
 * can both carry this without opening twice.
 */
export function folderKeyProps(actions: FolderActions, folder: string) {
  return {
    'aria-keyshortcuts': actions.canRename(folder) ? 'F2 Shift+F10' : 'Shift+F10',
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented || event.key !== 'F2' || !actions.canRename(folder)) return
      event.preventDefault()
      actions.renameFolder(folder)
    },
  }
}

/**
 * Props that make an element a folder: a drop target for documents, the
 * right-click menu and the folder's keys. `data-dropping` is the highlight,
 * set only while a document is over it.
 */
export function useFolderProps(folder: string) {
  const actions = useContext(FolderActionsContext)
  const [dropping, setDropping] = useState(false)
  return useMemo(() => {
    if (actions === undefined) return {}
    return {
      ...folderKeyProps(actions, folder),
      'data-dropping': dropping ? '' : undefined,
      onContextMenu: (event: MouseEvent) => {
        if (event.defaultPrevented) return
        event.preventDefault()
        actions.openFolderMenu(folder, event.clientX, event.clientY)
      },
      onDragOver: (event: DragEvent) => {
        if (!carriesDocument(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      },
      onDragEnter: (event: DragEvent) => {
        if (carriesDocument(event)) setDropping(true)
      },
      onDragLeave: (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false)
      },
      onDrop: (event: DragEvent) => {
        if (!carriesDocument(event)) return
        event.preventDefault()
        setDropping(false)
        actions.dropInto(folder, event.dataTransfer.getData(DOCUMENT_DRAG_TYPE))
      },
    }
  }, [actions, folder, dropping])
}
