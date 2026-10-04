import type { TrashRow } from '../../lib/files-source.js'
import { formatRelative } from './format-relative.js'
import { PurgeTrashEntryControl } from './PurgeTrashEntryControl.js'

export interface TrashRowItemProps {
  row: TrashRow
  busy: boolean
  onRestore: () => void
  /** Absent when the source cannot destroy an entry, which omits the action. */
  purge?: (documentId: string) => Promise<void>
  onPurgeSettled: () => void
}

/** One trash row: where the document was, when it went, and what can be done with it. */
export function TrashRowItem({
  row,
  busy,
  onRestore,
  purge,
  onPurgeSettled,
}: Readonly<TrashRowItemProps>) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="min-w-0 truncate" title={row.path}>
        {row.path}
        <span className="text-muted-foreground pl-2 text-xs">
          deleted {formatRelative(new Date(row.deletedAt).toISOString())}
        </span>
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={onRestore}
        className="text-muted-foreground hover:text-foreground shrink-0 rounded border px-2 py-0.5 text-xs"
      >
        Restore
      </button>
      {purge !== undefined && (
        <PurgeTrashEntryControl
          row={row}
          purge={purge}
          onSettled={onPurgeSettled}
          disabled={busy}
        />
      )}
    </li>
  )
}
