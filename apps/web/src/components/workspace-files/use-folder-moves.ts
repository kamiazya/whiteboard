import { useCallback, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { documentLabel } from '../../lib/document-label.js'
import { folderDisplayName } from '../../lib/folder-names.js'
import { pathInFolder } from './folder-moves.js'
import type { FolderNamesState } from './use-folder-names.js'
import { refusalMessage } from './use-rename-document.js'

/** One write at a time, with the keeper's refusal kept for the surface that asked. */
function useAttempt() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const attempt = useCallback(async (write: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await write()
      return true
    } catch (err) {
      setError(refusalMessage(err))
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, setError, attempt }
}

/**
 * The two writes behind the folder surfaces, with one busy flag and one
 * refusal between them: a document into a folder (`moveInto`), and a folder
 * renamed (`renameFolder`). A move is the keeper's own path move, so every
 * id, link and version rides along; a rename changes only what the folder is
 * CALLED — its address was fixed when it was made, so nothing moves and no
 * link has anything to follow.
 *
 * `announce` is spoken only for a write that landed. Each write answers
 * whether it landed; a refusal is left in `error` for the surface to word.
 */
export function useFolderMoves({
  moveDocument,
  announce,
  folderNames,
}: {
  /** The panel's own move: it follows the previewed document and re-reads. */
  moveDocument: (entry: WorkspaceDocumentEntry, newPath: string) => Promise<void>
  announce: (text: string) => void
  folderNames: FolderNamesState
}) {
  const { busy, error, setError, attempt } = useAttempt()
  const { names, rename } = folderNames

  const moveInto = useCallback(
    (entry: WorkspaceDocumentEntry, folder: string) =>
      attempt(async () => {
        const newPath = pathInFolder(entry.path, folder)
        if (newPath === entry.path) return
        await moveDocument(entry, newPath)
        announce(`Moved ${documentLabel(entry, 'leaf')} to ${folderDisplayName(folder, names)}`)
      }),
    [attempt, moveDocument, announce, names],
  )

  const renameFolder = useCallback(
    (path: string, name: string) =>
      attempt(async () => {
        const before = folderDisplayName(path, names)
        if (before === name) return
        await rename(path, name)
        announce(`Renamed folder ${before} to ${name}`)
      }),
    [attempt, rename, announce, names],
  )

  return { busy, error, setError, moveInto, renameFolder }
}
