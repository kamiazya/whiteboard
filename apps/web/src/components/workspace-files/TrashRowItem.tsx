import { useContext } from 'react'
import { documentLabel } from '../../lib/document-label.js'
import type { TrashRow } from '../../lib/files-source.js'
import { folderTrail } from '../../lib/folder-names.js'
import { formatRelative } from '../../lib/format-relative.js'
import { folderOf } from './folder-moves.js'
import { PurgeTrashEntryControl } from './PurgeTrashEntryControl.js'
import { FolderNamesContext } from './use-folder-names.js'

export interface TrashRowItemProps {
  row: TrashRow
  busy: boolean
  onRestore: () => void
  /** Absent when the source cannot destroy an entry, which omits the action. */
  purge?: (documentId: string) => Promise<void>
  onPurgeSettled: () => void
}

/** One trash row: what the document was called, where it was, when it went, and what can be done with it. */
export function TrashRowItem({
  row,
  busy,
  onRestore,
  purge,
  onPurgeSettled,
}: Readonly<TrashRowItemProps>) {
  const folder = folderOf(row.path)
  const names = useContext(FolderNamesContext)
  const where = folder === '' ? 'Workspace' : folderTrail(folder, names).join(' / ')
  return (
    <li className="flex items-center gap-2 pointer-coarse:min-h-11 pointer-coarse:gap-3">
      {/* flex-1, so Restore lines up down the column whatever the name's length. */}
      <span className="min-w-0 flex-1" title={row.path}>
        <span className="block truncate">{documentLabel(row, 'path')}</span>
        {/* Where it was, as the list names folders; the address comes last,
            for the one who needs to tell two "Untitled" apart. */}
        <span className="text-muted-foreground block truncate text-xs">
          In {where} · deleted {formatRelative(new Date(row.deletedAt).toISOString())}
          {row.name !== undefined && <span className="pl-2 font-mono opacity-70">{row.path}</span>}
        </span>
      </span>
      <button
        type="button"
        disabled={busy}
        onClick={onRestore}
        className="text-muted-foreground hover:text-foreground shrink-0 rounded border px-2 py-0.5 text-xs pointer-coarse:min-h-11 pointer-coarse:px-3"
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
