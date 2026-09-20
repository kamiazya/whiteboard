import { useCallback, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import type { WorkspaceFilesSource } from '../../lib/files-source.js'

/**
 * The rename flow: which document the dialog is open for, whether a submit is
 * in flight, and what refused it.
 *
 * Its own hook because the three states are read by nothing else — the dialog
 * and `submit` are the whole surface — and because a rename is the one write
 * here that applies TWO of them. A path change moves the document (which the
 * caller owns, since a move also decides which folder to show); a name change
 * does not. Either can be refused after the other has landed.
 */
export interface RenameDocument {
  /** The document the dialog is open for, or null when it is closed. */
  readonly renaming: WorkspaceDocumentEntry | null
  readonly busy: boolean
  readonly error: string | null
  /** Opens the dialog on `entry`, clearing whatever refused the last attempt. */
  readonly open: (entry: WorkspaceDocumentEntry) => void
  readonly cancel: () => void
  readonly submit: (
    entry: WorkspaceDocumentEntry,
    name: string | undefined,
    newPath: string,
  ) => Promise<void>
}

export function useRenameDocument({
  source,
  moveDocument,
  refreshAndSelect,
}: {
  readonly source: WorkspaceFilesSource
  /** Moves the document and decides where the panel lands; the caller's. */
  readonly moveDocument: (entry: WorkspaceDocumentEntry, newPath: string) => Promise<void>
  readonly refreshAndSelect: (path: string) => Promise<void>
}): RenameDocument {
  const [renaming, setRenaming] = useState<WorkspaceDocumentEntry | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = useCallback((entry: WorkspaceDocumentEntry) => {
    setError(null)
    setRenaming(entry)
  }, [])

  const cancel = useCallback(() => {
    setRenaming(null)
    setError(null)
  }, [])

  const submit = useCallback(
    async (entry: WorkspaceDocumentEntry, name: string | undefined, newPath: string) => {
      setBusy(true)
      setError(null)
      try {
        if ((entry.name ?? undefined) !== name) {
          await source.setDocumentName(entry, name)
        }
        if (newPath !== entry.path) {
          await moveDocument(entry, newPath)
        } else {
          await refreshAndSelect(entry.path)
        }
        setRenaming(null)
      } catch (err) {
        // The server names the PRODUCED path that collided, which on a
        // subtree move is often not the one typed here.
        setError(err instanceof Error ? err.message : 'Could not rename it.')
        // A rename applies two writes; the first may have landed before the
        // second was refused. Re-reading here is what stops the panel from
        // showing a name the store no longer holds — the refusal is about
        // the path, and the rest of the screen must still be true.
        try {
          await refreshAndSelect(entry.path)
        } catch {
          // The list read failing on top of a failed rename leaves what is
          // already on screen; the dialog's own message is the report.
        }
      } finally {
        setBusy(false)
      }
    },
    [source, moveDocument, refreshAndSelect],
  )

  return { renaming, busy, error, open, cancel, submit }
}
