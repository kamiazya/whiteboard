import { useCallback, useEffect, useRef, useState } from 'react'
import { documentLabel } from '../../lib/document-label.js'
import type { TrashRow } from '../../lib/files-source.js'

/** Long enough to read the line and reach the button on a phone. */
const UNDO_WINDOW_MS = 10_000

/**
 * The deletes a person just made, as the trash sees them: rows that entered
 * it since its previous read. Null `seen` is "not read yet" — a trash that
 * was already full on arrival is not news, and must not offer an undo for
 * something deleted last week.
 */
export function useUndoDelete(restore: (documentId: string) => Promise<void>) {
  const seen = useRef<ReadonlySet<string> | null>(null)
  const [arrived, setArrived] = useState<readonly TrashRow[]>([])

  const noteRead = useCallback((next: readonly TrashRow[]) => {
    const before = seen.current
    seen.current = new Set(next.map((row) => row.documentId))
    if (before === null) return
    const fresh = next.filter((row) => !before.has(row.documentId))
    if (fresh.length > 0) setArrived(fresh)
  }, [])

  useEffect(() => {
    if (arrived.length === 0) return
    const timer = setTimeout(() => setArrived([]), UNDO_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [arrived])

  /**
   * `afterUndo` runs once it settled, restored or not — the trash and the
   * list are stale either way. Passed per call because the trash read that
   * `noteRead` serves is what defines it.
   */
  const undo = useCallback(
    async (afterUndo: () => void, onFailure: (err: unknown) => void) => {
      const toRestore = arrived
      setArrived([])
      try {
        for (const row of toRestore) await restore(row.documentId)
      } catch (err) {
        onFailure(err)
      } finally {
        afterUndo()
      }
    },
    [arrived, restore],
  )

  return { arrived, noteRead, undo }
}

/** "Deleted <name> — Undo", floating over the list until it times out or is used. */
export function UndoDeleteToast({
  arrived,
  onUndo,
}: {
  arrived: readonly TrashRow[]
  onUndo: () => void
}) {
  const first = arrived[0]
  if (first === undefined) return null
  const what = arrived.length === 1 ? documentLabel(first, 'path') : `${arrived.length} documents`
  return (
    <div className="fixed bottom-4 left-1/2 z-50 max-w-[calc(100%-2rem)] -translate-x-1/2">
      <div
        role="status"
        aria-live="polite"
        className="bg-background animate-in fade-in-0 slide-in-from-bottom-2 flex items-center gap-3 rounded-lg border px-4 py-2 text-sm shadow-lg duration-(--motion-duration-normal) ease-(--motion-ease-out)"
      >
        <span className="min-w-0 truncate">Deleted {what}</span>
        <button
          type="button"
          onClick={onUndo}
          className="hover:bg-accent rounded-md border px-2 py-0.5 font-medium pointer-coarse:min-h-11 pointer-coarse:px-3"
        >
          Undo
        </button>
      </div>
    </div>
  )
}
