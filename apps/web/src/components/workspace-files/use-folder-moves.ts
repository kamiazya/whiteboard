import { useCallback, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { documentLabel } from '../../lib/document-label.js'
import type { WorkspaceFilesSource } from '../../lib/files-source.js'
import {
  folderLabel,
  folderOf,
  joinPath,
  leafOf,
  pathAfterFolderMove,
  pathInFolder,
} from './folder-moves.js'
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

interface FolderRenameDeps {
  source: WorkspaceFilesSource
  /** The folder the contents pane shows. */
  folder: string
  selectedPath: string | undefined
  refreshAndSelect: (path: string) => Promise<unknown>
  goToFolder: (folder: string) => void
}

/**
 * Rename the folder by moving its path prefix, then put the panel where the
 * same things now are: the contents pane and the preview follow the rename
 * when they were inside it.
 */
async function renameFolderTree(
  { source, folder: currentFolder, selectedPath, refreshAndSelect, goToFolder }: FolderRenameDeps,
  folder: string,
  target: string,
): Promise<void> {
  await source.renameDocumentPath(folder, target)
  const inside = pathAfterFolderMove(currentFolder, folder, target)
  if (inside !== currentFolder) goToFolder(inside)
  try {
    await refreshAndSelect(
      selectedPath === undefined ? '' : pathAfterFolderMove(selectedPath, folder, target),
    )
  } catch {
    // The rename stands; the list will catch up on the next read.
  }
}

/**
 * The two writes behind the folder surfaces, with one busy flag and one
 * refusal between them: a document into a folder (`moveInto`), and a folder
 * renamed (`renameFolder`). Both are the keeper's own path move — a folder
 * is the prefix of its documents' paths, so a rename moves the subtree and
 * every id, link and version rides along.
 *
 * `announce` is spoken only for a write that landed. Each write answers
 * whether it landed; a refusal is left in `error` for the surface to word.
 */
export function useFolderMoves({
  moveDocument,
  announce,
  ...rename
}: FolderRenameDeps & {
  /** The panel's own move: it follows the previewed document and re-reads. */
  moveDocument: (entry: WorkspaceDocumentEntry, newPath: string) => Promise<void>
  announce: (text: string) => void
}) {
  const { busy, error, setError, attempt } = useAttempt()

  const moveInto = useCallback(
    (entry: WorkspaceDocumentEntry, folder: string) =>
      attempt(async () => {
        const newPath = pathInFolder(entry.path, folder)
        if (newPath === entry.path) return
        await moveDocument(entry, newPath)
        announce(`Moved ${documentLabel(entry, 'leaf')} to ${folderLabel(folder)}`)
      }),
    [attempt, moveDocument, announce],
  )

  const { source, folder, selectedPath, refreshAndSelect, goToFolder } = rename
  const renameFolder = useCallback(
    (from: string, name: string) =>
      attempt(async () => {
        const target = joinPath(folderOf(from), name)
        if (target === from) return
        await renameFolderTree(
          { source, folder, selectedPath, refreshAndSelect, goToFolder },
          from,
          target,
        )
        announce(`Renamed folder ${leafOf(from)} to ${name}`)
      }),
    [attempt, source, folder, selectedPath, refreshAndSelect, goToFolder, announce],
  )

  return { busy, error, setError, moveInto, renameFolder }
}
