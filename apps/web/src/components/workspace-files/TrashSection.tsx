/**
 * What deletes evacuated, restorable in place — or destroyed for good, after
 * a confirmation, when the source can.
 *
 * Rendered only when there is something in it: an empty trash is silence,
 * not an empty box — the section exists for the moment someone deleted a
 * document and wants it back, and any other moment it would only push the
 * list up. Collapsed by default for the same reason.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { WorkspaceCapacityReachedError } from '../../lib/browser-keeper-capacity.js'
import { documentLabel } from '../../lib/document-label.js'
import type { TrashRow } from '../../lib/files-source.js'
import { TrashRowItem } from './TrashRowItem.js'

export interface TrashSectionProps {
  listTrash: () => Promise<readonly TrashRow[]>
  restoreFromTrash: (documentId: string) => Promise<void>
  /**
   * Destroy one entry for good. Optional like the rest of the trash seam: a
   * source that cannot omits the action rather than offering it.
   */
  purgeFromTrash?: (documentId: string) => Promise<void>
  /** The document list above holds a restored document now — re-read it. */
  onRestored: () => void
  /** External writes (a delete just landed) — re-read the trash. */
  revision?: unknown
}

// A full workspace is the one refusal a person can act on, so it says how;
// anything else stays the generic line.
function restoreFailureMessage(err: unknown): string {
  return err instanceof WorkspaceCapacityReachedError
    ? err.message
    : 'Could not restore this document.'
}

/** Long enough to read the line and reach the button on a phone. */
const UNDO_WINDOW_MS = 10_000

export function TrashSection({
  listTrash,
  restoreFromTrash,
  purgeFromTrash,
  onRestored,
  revision,
}: TrashSectionProps) {
  const [rows, setRows] = useState<readonly TrashRow[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Rows that entered the trash since the last read — the delete the person
  // just made, which is the one they may want back. Null `seen` is "not read
  // yet": a trash that was already full on arrival is not news.
  const seen = useRef<ReadonlySet<string> | null>(null)
  const [arrived, setArrived] = useState<readonly TrashRow[]>([])

  // Only the NEWEST read may write: a slow pre-restore list resolving after
  // the post-restore reload would put the restored row back in the section.
  const readSeq = useRef(0)
  const reload = useCallback(() => {
    const seq = ++readSeq.current
    // A failed trash read degrades to an absent section, never to an error
    // banner: the list above is the primary surface and must not inherit a
    // failure from an auxiliary one.
    listTrash().then(
      (next) => {
        if (seq !== readSeq.current) return
        const before = seen.current
        seen.current = new Set(next.map((row) => row.documentId))
        if (before !== null) {
          const fresh = next.filter((row) => !before.has(row.documentId))
          if (fresh.length > 0) setArrived(fresh)
        }
        setRows(next)
      },
      () => {
        if (seq === readSeq.current) setRows([])
      },
    )
  }, [listTrash])

  useEffect(reload, [reload, revision])

  const restore = useCallback(
    async (documentId: string) => {
      setBusy(documentId)
      setError(null)
      try {
        await restoreFromTrash(documentId)
        reload()
        onRestored()
      } catch (err) {
        setError(restoreFailureMessage(err))
      } finally {
        setBusy(null)
      }
    },
    [restoreFromTrash, reload, onRestored],
  )

  useEffect(() => {
    if (arrived.length === 0) return
    const timer = setTimeout(() => setArrived([]), UNDO_WINDOW_MS)
    return () => clearTimeout(timer)
  }, [arrived])

  const undo = useCallback(async () => {
    const toRestore = arrived
    setArrived([])
    setError(null)
    try {
      for (const row of toRestore) await restoreFromTrash(row.documentId)
    } catch (err) {
      setError(restoreFailureMessage(err))
    } finally {
      reload()
      onRestored()
    }
  }, [arrived, restoreFromTrash, reload, onRestored])

  if (rows.length === 0) return null

  const deletedWhat =
    arrived.length === 1 && arrived[0] !== undefined
      ? documentLabel(arrived[0], 'path')
      : `${arrived.length} documents`

  return (
    <>
      {arrived.length > 0 && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 max-w-[calc(100%-2rem)]">
          <div
            role="status"
            aria-live="polite"
            className="bg-background animate-in fade-in-0 slide-in-from-bottom-2 flex items-center gap-3 rounded-lg border px-4 py-2 text-sm shadow-lg duration-(--motion-duration-normal) ease-(--motion-ease-out)"
          >
            <span className="min-w-0 truncate">Deleted {deletedWhat}</span>
            <button
              type="button"
              onClick={() => void undo()}
              className="hover:bg-accent rounded-md border px-2 py-0.5 font-medium pointer-coarse:min-h-11 pointer-coarse:px-3"
            >
              Undo
            </button>
          </div>
        </div>
      )}
      <details className="border-t px-2 py-1 text-sm" data-testid="trash-section">
        <summary className="text-muted-foreground cursor-pointer text-xs font-medium pointer-coarse:flex pointer-coarse:min-h-11 pointer-coarse:items-center">
          Trash ({rows.length})
        </summary>
        {error !== null && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
        <ul className="flex flex-col gap-1 pt-1 pointer-coarse:gap-2">
          {rows.map((row) => (
            <TrashRowItem
              key={row.documentId}
              row={row}
              busy={busy === row.documentId}
              onRestore={() => void restore(row.documentId)}
              purge={purgeFromTrash}
              onPurgeSettled={reload}
            />
          ))}
        </ul>
      </details>
    </>
  )
}
