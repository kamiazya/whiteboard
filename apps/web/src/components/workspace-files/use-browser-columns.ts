import { useCallback, useState } from 'react'
import { safeGetItem, safeSetItem } from '../../lib/safe-local-storage.js'

/**
 * How many columns stand between the workspace and the preview.
 *
 * `one` is the whole tree — folders and documents together, reachable
 * without moving anything, which is what you want when you know where you
 * are going. `two` splits it: folders on the left, that folder's contents
 * as cards beside them, which is what you want when you are looking rather
 * than navigating. Neither is a subset of the other, which is why this is a
 * toggle and not a width breakpoint.
 */
export type BrowserColumns = 'one' | 'two'

const COLUMNS_STORAGE_KEY = 'whiteboard.document-browser.columns.v1'

/**
 * The column count is a per-device PREFERENCE, deliberately not part of the
 * address: a link someone shares must not impose the sender's layout on
 * whoever opens it. The open folder is the other side of that line — it is
 * what you are looking at, so it lives in the URL.
 *
 * Every access is guarded because storage does not merely come back empty
 * when it is unavailable — a private window or blocked site data makes the
 * accessor itself throw — and because nothing stops the stored value being
 * anything at all.
 */
function readStoredColumns(): BrowserColumns {
  return safeGetItem(COLUMNS_STORAGE_KEY) === 'one' ? 'one' : 'two'
}

function storeColumns(next: BrowserColumns): void {
  // A remembered layout is a courtesy; losing it must never break the view.
  safeSetItem(COLUMNS_STORAGE_KEY, next)
}

/** The column preference: read once on mount, persisted on every choice. */
export function useBrowserColumns(): {
  columns: BrowserColumns
  chooseColumns: (next: BrowserColumns) => void
} {
  const [columns, setColumns] = useState<BrowserColumns>(readStoredColumns)
  const chooseColumns = useCallback((next: BrowserColumns) => {
    setColumns(next)
    storeColumns(next)
  }, [])
  return { columns, chooseColumns }
}
