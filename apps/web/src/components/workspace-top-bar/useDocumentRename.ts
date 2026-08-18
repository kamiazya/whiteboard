import type { MutableRefObject } from 'react'
import { useState } from 'react'

interface UseDocumentRenameOptions {
  path: string
  isLocalMode: boolean
  currentName: string | undefined
  onRenameDocument: ((name: string) => void | Promise<void>) | undefined
  renameDocument: (path: string, name: string) => Promise<boolean>
  // Shared with copy/create — see useCreateDocument's mountedRef doc.
  mountedRef: MutableRefObject<boolean>
}

// Owns the inline canvas-rename input's local UI state. Daemon-mode commits
// go through `renameDocument` (useDocumentNames' writer); local mode has no
// workspaceNamesSchema state to update at all — it calls the host page's
// onRenameDocument instead and surfaces a rejection through `renameError`,
// which has no daemon-mode equivalent (a failed PUT there just leaves the
// previous name in place with no separate error channel).
export function useDocumentRename({
  path,
  isLocalMode,
  currentName,
  onRenameDocument,
  renameDocument,
  mountedRef,
}: UseDocumentRenameOptions) {
  const [renamingDocument, setRenamingCanvas] = useState(false)
  const [draft, setDraft] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)

  const startRename = () => {
    setDraft(currentName ?? '')
    setRenamingCanvas(true)
  }

  const commitDocumentName = async () => {
    const name = draft.trim()
    if (isLocalMode) {
      try {
        await onRenameDocument?.(name)
        if (mountedRef.current) {
          setRenamingCanvas(false)
          setDraft('')
          setRenameError(null)
        }
      } catch {
        // Keep the input open on failure (mirrors openNewDocument) so the
        // user can retry without retyping the name.
        if (mountedRef.current) setRenameError('Failed to rename canvas.')
      }
      return
    }
    await renameDocument(path, name)
    if (mountedRef.current) {
      setRenamingCanvas(false)
      setDraft('')
    }
  }

  const cancelRename = () => {
    setRenamingCanvas(false)
    setDraft('')
    setRenameError(null)
  }

  return {
    renamingDocument,
    draft,
    setDraft,
    renameError,
    startRename,
    commitDocumentName,
    cancelRename,
  }
}
