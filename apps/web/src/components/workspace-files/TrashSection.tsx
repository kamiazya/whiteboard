/**
 * What deletes evacuated, restorable in place.
 *
 * Rendered only when there is something in it: an empty trash is silence,
 * not an empty box — the section exists for the moment someone deleted a
 * document and wants it back, and any other moment it would only push the
 * list up. Collapsed by default for the same reason.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TrashRow } from './files-source.js'
import { formatRelative } from './format-relative.js'

export interface TrashSectionProps {
  listTrash: () => Promise<readonly TrashRow[]>
  restoreFromTrash: (documentId: string) => Promise<void>
  /** The document list above holds a restored document now — re-read it. */
  onRestored: () => void
  /** External writes (a delete just landed) — re-read the trash. */
  revision?: unknown
}

export function TrashSection({
  listTrash,
  restoreFromTrash,
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
      } catch {
        setError('Could not restore this document.')
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
          <li key={row.documentId} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate" title={row.path}>
              {row.path}
              <span className="text-muted-foreground pl-2 text-xs">
                deleted {formatRelative(new Date(row.deletedAt).toISOString())}
              </span>
            </span>
            <button
              type="button"
              disabled={busy === row.documentId}
              onClick={() => void restore(row.documentId)}
              className="text-muted-foreground hover:text-foreground shrink-0 rounded border px-2 py-0.5 text-xs"
            >
              Restore
            </button>
          </li>
        ))}
      </ul>
    </details>
  )
}
