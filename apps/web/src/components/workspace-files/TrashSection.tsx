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
import type { TrashRow } from '../../lib/files-source.js'
import { TrashRowItem } from './TrashRowItem.js'

export interface TrashSectionProps {
  listTrash: () => Promise<readonly TrashRow[]>
  restoreFromTrash: (documentId: string) => Promise<void>
  /**
   * Destroy one entry for good. Optional like the rest of the trash seam: a
   * source that cannot omits the action rather than offering it.
   */
  purgeFromTrash?: ((documentId: string) => Promise<void>) | undefined
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
        if (seq === readSeq.current) setRows(next)
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

  if (rows.length === 0) return null

  return (
    <details className="border-t px-2 py-1 text-sm" data-testid="trash-section">
      <summary className="text-muted-foreground cursor-pointer text-xs font-medium">
        Trash ({rows.length})
      </summary>
      {error !== null && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <ul className="flex flex-col gap-1 pt-1">
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
  )
}
