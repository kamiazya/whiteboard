/**
 * One storage row, and the cleanup control it may carry.
 *
 * Every control is the same button with a different verb, differing only in
 * its icon and in having a fallback line when no transient status is showing.
 * They are one component here, picked from a table the card owns; a row that
 * has two things done to the bytes it holds (the database is optimized and has
 * its auto-versions pruned) lists both.
 */
import type { StorageCategory } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '../components/ui/button.js'
import { formatBytes } from '../lib/format-bytes.js'

/** What a row's cleanup control does and says. */
export interface RowAction {
  icon: LucideIcon
  idleLabel: string
  busyLabel: string
  ariaLabel: string
  busy: boolean
  run: () => void
  /** The line under the button; `null` renders nothing. */
  status: ReactNode
}

export interface CategoryDescriptor {
  // Keyed by the wire contract's own category union, so a row for something
  // the daemon cannot report does not compile. As `string`, a `libraries`
  // row would survive the deletion of its server half by rendering a
  // permanent 0 B — a value indistinguishable from "nothing stored yet".
  key: StorageCategory
  label: string
  description: string
}

/**
 * The action slot, which every row has even when it is empty: a reserved
 * same-width slot is what stops a future addition nudging the other rows.
 */
function RowActions({
  categoryKey,
  actions,
}: {
  categoryKey: string
  actions: readonly RowAction[]
}) {
  return (
    <div
      className="shrink-0 min-w-[2.25rem] flex flex-col items-end gap-1.5"
      data-storage-actions={categoryKey}
    >
      {actions.map((action) => (
        <div key={action.ariaLabel} className="flex flex-col items-end gap-0.5">
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5"
            onClick={action.run}
            disabled={action.busy}
            aria-label={action.ariaLabel}
          >
            <action.icon className={action.busy ? 'size-3.5 animate-pulse' : 'size-3.5'} />
            <span className="text-xs">{action.busy ? action.busyLabel : action.idleLabel}</span>
          </Button>
          {action.status !== null && (
            <span className="text-[10px] text-muted-foreground">{action.status}</span>
          )}
        </div>
      ))}
    </div>
  )
}

export function StorageCategoryRow({
  descriptor,
  bucket,
  actions,
}: {
  descriptor: CategoryDescriptor
  bucket: { bytes: number; files: number }
  actions: readonly RowAction[]
}) {
  const { key, label, description } = descriptor
  return (
    <li key={key} data-storage-row={key} className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{label}</div>
        <div className="text-xs text-muted-foreground truncate">{description}</div>
      </div>
      <div className="shrink-0 text-right font-mono text-xs tabular-nums">
        <div>{formatBytes(bucket.bytes)}</div>
        <div className="text-[10px] text-muted-foreground">{bucket.files} files</div>
      </div>
      <RowActions categoryKey={key} actions={actions} />
    </li>
  )
}
