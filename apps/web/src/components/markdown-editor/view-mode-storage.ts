import { hasCoarsePointer } from '../../lib/platform.js'
import { safeGetItem } from '../../lib/safe-local-storage.js'
import type { MarkdownViewMode } from './EditorToolbar.js'

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
