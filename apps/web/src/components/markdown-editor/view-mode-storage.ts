import { useState } from 'react'
import { hasCoarsePointer } from '../../lib/platform.js'
import { safeGetItem, safeSetItem } from '../../lib/safe-local-storage.js'
import type { MarkdownViewMode } from './EditorToolbar.js'
import { useNotePrintRequest } from './note-print.js'

export const VIEW_MODE_STORAGE_KEY = 'whiteboard.markdown-view-mode'

function isViewMode(value: unknown): value is MarkdownViewMode {
  return value === 'write' || value === 'split' || value === 'read'
}

export function readStoredViewMode(): MarkdownViewMode {
  const stored = safeGetItem(VIEW_MODE_STORAGE_KEY)
  if (isViewMode(stored)) return stored
  // Unchosen, a finger-driven screen starts in Write: its portrait width
  // cannot hold Split, and a default of Split would flip the note to two
  // panes the moment the phone rotates, without anyone having asked.
  return hasCoarsePointer() ? 'write' : 'split'
}

/**
 * The editor's view mode: the stored preference unless the mount names one,
 * the reader's changes written back to it, and a print request answered by
 * switching to Read for the length of the print (`useNotePrintRequest`).
 */
export function useViewMode(initialViewMode: MarkdownViewMode | undefined): {
  readonly mode: MarkdownViewMode
  readonly changeMode: (next: MarkdownViewMode) => void
} {
  const [mode, setMode] = useState<MarkdownViewMode>(() => initialViewMode ?? readStoredViewMode())
  useNotePrintRequest(mode, setMode)
  const changeMode = (next: MarkdownViewMode) => {
    setMode(next)
    // A mount with an explicit initial mode stays detached from the shared
    // preference when the mode changes too — half an isolation (read the
    // prop, still write the store) would leave the writer side poisoning
    // concurrent mounts.
    if (initialViewMode !== undefined) return
    // Preference persistence is best-effort; the session state still works.
    safeSetItem(VIEW_MODE_STORAGE_KEY, next)
  }
  return { mode, changeMode }
}
