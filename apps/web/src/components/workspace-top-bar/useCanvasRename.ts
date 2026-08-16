import type { MutableRefObject } from 'react'
import { useState } from 'react'

interface UseCanvasRenameOptions {
  path: string
  isLocalMode: boolean
  currentName: string | undefined
  onRenameCanvas: ((name: string) => void | Promise<void>) | undefined
  renameCanvas: (path: string, name: string) => Promise<boolean>
  // Shared with copy/create — see useCreateCanvas's mountedRef doc.
  mountedRef: MutableRefObject<boolean>
}

// Owns the inline canvas-rename input's local UI state. Daemon-mode commits
// go through `renameCanvas` (useCanvasNames' writer); local mode has no
// workspaceNamesSchema state to update at all — it calls the host page's
// onRenameCanvas instead and surfaces a rejection through `renameError`,
// which has no daemon-mode equivalent (a failed PUT there just leaves the
// previous name in place with no separate error channel).
export function useCanvasRename({
  path,
  isLocalMode,
  currentName,
  onRenameCanvas,
  renameCanvas,
  mountedRef,
}: UseCanvasRenameOptions) {
  const [renamingCanvas, setRenamingCanvas] = useState(false)
  const [draft, setDraft] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)

  const startRename = () => {
    setDraft(currentName ?? '')
    setRenamingCanvas(true)
  }

  const commitCanvasName = async () => {
    const name = draft.trim()
    if (isLocalMode) {
      try {
        await onRenameCanvas?.(name)
        if (mountedRef.current) {
          setRenamingCanvas(false)
          setDraft('')
          setRenameError(null)
        }
      } catch {
        // Keep the input open on failure (mirrors openNewCanvas) so the
        // user can retry without retyping the name.
        if (mountedRef.current) setRenameError('Failed to rename canvas.')
      }
      return
    }
    await renameCanvas(path, name)
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
    renamingCanvas,
    draft,
    setDraft,
    renameError,
    startRename,
    commitCanvasName,
    cancelRename,
  }
}
