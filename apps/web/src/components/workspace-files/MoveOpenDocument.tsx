import { type MutableRefObject, useEffect, useRef, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import type { WorkspaceFilesSource } from '../../lib/files-source.js'
import { useFolderActions } from './use-folder-actions.js'

/** Opens the picker for the document at the page's current path. */
export type OpenMovePicker = () => void

/**
 * "Move to folder…" for the OPEN document: the documents list's own picker,
 * moves and announcement (`useFolderActions`), so the two places cannot offer
 * different folders or say different things. The list is read from the
 * keeper when the picker is asked for, since the page holds no list of its
 * own in this shape; the move itself is the page's, which knows how to follow
 * the document to its new address.
 *
 * `openRef` is filled with what opens the picker, for the menu row to call.
 */
export function MoveOpenDocument({
  source,
  path,
  moveTo,
  openRef,
}: {
  source: WorkspaceFilesSource
  /** The open document's path, or null before it is known. */
  path: string | null
  /** Moves the open document to `newPath`; resolves once the page follows it. */
  moveTo: (newPath: string) => Promise<void>
  openRef: MutableRefObject<OpenMovePicker | null>
}) {
  const [documents, setDocuments] = useState<readonly WorkspaceDocumentEntry[] | null>(null)
  const [asked, setAsked] = useState(false)
  const rootRef = useRef<HTMLElement | null>(null)
  const folders = useFolderActions({
    source,
    documents,
    rootRef,
    moveDocument: (_entry, newPath) => moveTo(newPath),
    goToFolder: () => {},
  })

  openRef.current = () => {
    void source.listDocuments().then((listed) => {
      setDocuments(listed)
      setAsked(true)
    })
  }

  const { openMovePicker } = folders
  useEffect(() => {
    if (!asked || documents === null) return
    setAsked(false)
    const entry = documents.find((each) => each.path === path)
    if (entry !== undefined) openMovePicker(entry)
  }, [asked, documents, path, openMovePicker])

  return folders.layer
}
