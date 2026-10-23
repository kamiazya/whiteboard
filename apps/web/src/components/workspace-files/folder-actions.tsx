import {
  createContext,
  type DragEvent,
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
 * Props that make an element a folder: a drop target for documents and the
 * right-click menu. `data-dropping` is the highlight, set only while a
 * document is over it.
 */
export function useFolderProps(folder: string) {
  const actions = useContext(FolderActionsContext)
  const [dropping, setDropping] = useState(false)
  return useMemo(() => {
    if (actions === undefined) return {}
    return {
      'data-dropping': dropping ? '' : undefined,
      onContextMenu: (event: MouseEvent) => {
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
