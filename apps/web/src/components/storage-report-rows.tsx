/**
 * One storage row, and the cleanup control it may carry.
 *
 * Three of the four action slots were the same button with different verbs,
 * and the fourth differed only in its icon and in having a fallback line
 * when no transient status is showing. They are one component here, picked
 * from a table the card owns.
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
  // the daemon cannot report does not compile. It used to be `string`, and a
  // `libraries` row survived the deletion of its server half by rendering a
  // permanent 0 B — a value indistinguishable from "nothing stored yet".
  key: StorageCategory
  label: string
  description: string
  // Optional soft cap. When the row's bytes pass this threshold the row
  // surfaces a "near / over cap" hint. No auto-prune happens here; this
  // component only makes growth visible before any cleanup policy runs.
  softCapBytes?: number
}

/**
 * What the small print under a row's size says: the cap warning when there
 * is one to give, and the file count otherwise.
 */
function capNote(bytes: number, softCapBytes: number | undefined, files: number): string {
  if (softCapBytes === undefined) return `${files} files`
  if (bytes > softCapBytes) return 'Over soft cap — please uninstall unused'
  if (bytes > softCapBytes * 0.8) return 'Approaching soft cap'
  return `${files} files`
}

/**
 * The action slot, which every row has even when it is empty: a reserved
 * same-width slot is what stops a future addition nudging the other rows.
 */
function RowActions({
  categoryKey,
  action,
}: {
  categoryKey: string
  action: RowAction | undefined
}) {
  return (
    <div
      className="shrink-0 min-w-[2.25rem] flex flex-col items-end gap-0.5"
      data-storage-actions={categoryKey}
    >
      {action !== undefined && (
        <>
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
        </>
      )}
    </div>
  )
}

export function StorageCategoryRow({
  descriptor,
  bucket,
  action,
}: {
  descriptor: CategoryDescriptor
  bucket: { bytes: number; files: number }
  action: RowAction | undefined
}) {
  const { key, label, description, softCapBytes } = descriptor
  const overCap = softCapBytes !== undefined && bucket.bytes > softCapBytes
  return (
    <li key={key} data-storage-row={key} className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{label}</div>
        <div className="text-xs text-muted-foreground truncate">{description}</div>
      </div>
      <div className="shrink-0 text-right font-mono text-xs tabular-nums">
        <div className={overCap ? 'text-destructive' : undefined}>
          {formatBytes(bucket.bytes)}
          {softCapBytes !== undefined && (
            <span className="text-muted-foreground"> / {formatBytes(softCapBytes)}</span>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {capNote(bucket.bytes, softCapBytes, bucket.files)}
        </div>
      </div>
      <RowActions categoryKey={key} action={action} />
    </li>
  )
}
