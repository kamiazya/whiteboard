/**
 * Every copy of a workspace this device keeps, and a delete for the ones it
 * is safe to delete.
 *
 * ADR-0042 decision 3 calls removing a cached replica HOUSEKEEPING rather
 * than security — the daemon still keeps the workspace, so nothing about
 * access changes — and that is why the replica page deliberately offers no
 * remove control. This is the home the ADR names for it.
 *
 * The inventory is TWO disjoint sets, and both have to be listed:
 *
 * - browser-kept workspaces, which have a `workspaces` registry row;
 * - cached replicas of daemon workspaces, which have a `storage.replicas`
 *   claim and NO registry row.
 *
 * Neither can be read from the byte store — `IdbDocumentStore` has no list
 * method — so the two sources above are the whole picture.
 *
 * Only a REPLICA offers a delete. A browser-kept workspace is the only copy
 * of its data anywhere, so deleting it here would be data loss dressed as
 * tidying; the one case where that is safe (after a verified promote to a
 * daemon) already has its own path in `demote-browser-workspace.ts`. The row
 * still appears, because a list of "every copy" that silently omits half of
 * them is worse than no list.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { getAppLogger } from '../../lib/app-logger.js'
import { DESTRUCTIVE_COPY } from '../../lib/destructive-copy.js'
import { forgetReplicaEntry, listReplicas, type ReplicaMatch } from '../../lib/replicas.js'
import type { UserSettingsStore } from '../../lib/user-settings-store.js'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog.js'
import { Button } from '../ui/button.js'
import { formatRelative } from '../workspace-files/format-relative.js'

const log = getAppLogger('local-copies')

/** What a row needs, whichever set it came from. */
interface CopyRow {
  workspaceId: string
  /** What to call it: the display name a keeper recorded, else its handle. */
  label: string
  keeper: 'browser' | 'daemon'
  /** Present for a replica: which daemon keeps the original. */
  daemonBaseUrl?: string
  syncedAt?: string
}

function replicaRow(entry: ReplicaMatch): CopyRow {
  return {
    workspaceId: entry.workspaceId,
    label: entry.displayName ?? entry.segment ?? entry.workspaceId,
    keeper: 'daemon',
    daemonBaseUrl: entry.daemonBaseUrl,
    syncedAt: entry.syncedAt,
  }
}

/** The daemon's host, which is what a person recognises. A malformed URL is
 *  shown as it was stored rather than hidden: the entry is what it is. */
function daemonLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/** One row. `onDelete` is handed the button so the card can restore focus
 *  to it after the dialog closes — one dialog serves every row, so there is
 *  no `AlertDialogTrigger` to do that for us. */
function CopyRowItem({
  row,
  openHere,
  onDelete,
}: {
  row: CopyRow
  openHere: boolean
  onDelete: (trigger: HTMLButtonElement) => void
}) {
  return (
    <li
      data-testid={`local-copy-${row.workspaceId}`}
      className="flex items-start justify-between gap-3"
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-sm">{row.label}</span>
        <span className="text-muted-foreground text-xs">
          {row.keeper === 'browser'
            ? 'Kept in this browser — the only copy of it anywhere, so it cannot be removed here.'
            : `Cached from ${daemonLabel(row.daemonBaseUrl ?? '')}${
                row.syncedAt === undefined ? '' : ` · synced ${formatRelative(row.syncedAt)}`
              }`}
        </span>
      </div>
      {row.keeper === 'daemon' &&
        (openHere ? (
          <span className="text-muted-foreground text-xs">Open here</span>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(event) => onDelete(event.currentTarget)}
          >
            Delete copy
          </Button>
        ))}
    </li>
  )
}

export function LocalCopiesCard({
  settingsStore,
  workspaceId,
}: {
  settingsStore: UserSettingsStore
  /** The workspace this session is showing, if any — its copy cannot be
   *  deleted from under the page that is reading it. */
  workspaceId?: string
}) {
  const headingId = useId()
  const [rows, setRows] = useState<CopyRow[] | null>(null)
  const [keptReadable, setKeptReadable] = useState(true)
  const [pending, setPending] = useState<CopyRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const load = useCallback(async () => {
    // The claims come from the settings blob in localStorage and need no
    // database, so they are read first and survive the registry being
    // unreadable below.
    const replicas = listReplicas(settingsStore.load()).map(replicaRow)
    let kept: CopyRow[] = []
    let keptReadable = true
    try {
      // Dynamic: the browser registry drags IndexedDB and the document index,
      // which a Settings visit should not pay for until this card mounts.
      const { listBrowserWorkspaces } = await import('../../lib/browser-workspaces.js')
      kept = (await listBrowserWorkspaces()).map((entry) => ({
        workspaceId: entry.workspaceId,
        label: entry.displayName ?? entry.segment ?? entry.workspaceId,
        keeper: 'browser' as const,
      }))
    } catch (error) {
      // A browser can refuse IndexedDB outright — a private window, blocked
      // site data — and then this half of the inventory cannot be read at
      // all. The claims still can, so the card degrades to what it knows and
      // says the rest is unknown rather than implying this device keeps
      // nothing of its own. `info`, not a failure: the environment said no,
      // nothing broke.
      keptReadable = false
      log.info('the browser workspace registry could not be read', error)
    }
    setRows([...kept, ...replicas])
    setKeptReadable(keptReadable)
  }, [settingsStore])

  useEffect(() => {
    void load()
  }, [load])

  const confirmDelete = useCallback(
    async (row: CopyRow) => {
      setDeleting(true)
      try {
        // The CLAIM first, the bytes second — `demote-browser-workspace.ts`
        // takes the same order for the same reason: a failure between the two
        // leaves bytes nothing points at, which the next pull overwrites,
        // where the reverse leaves a claim pointing at a record that is gone
        // and every reader of it has to cope with the absence.
        settingsStore.update((current) => forgetReplicaEntry(current, row.workspaceId))
        const { openDocumentStore } = await import('../../lib/replica-store.js')
        await openDocumentStore().deleteDoc({
          docRef: { kind: 'workspace-tree', workspaceId: row.workspaceId },
        })
        setPending(null)
        await load()
      } finally {
        setDeleting(false)
      }
    },
    [load, settingsStore],
  )

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="font-medium text-sm">
        Copies on this device
      </h3>
      {!keptReadable && (
        <p className="text-muted-foreground text-xs">
          This browser would not open its own storage, so any workspace it keeps itself is not
          listed here.
        </p>
      )}
      {rows === null ? (
        <p className="text-muted-foreground text-xs">Looking for copies…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">This device keeps no workspace of its own.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <CopyRowItem
              key={`${row.keeper}:${row.workspaceId}`}
              row={row}
              openHere={row.workspaceId === workspaceId}
              onDelete={(trigger) => {
                triggerRef.current = trigger
                setPending(row)
              }}
            />
          ))}
        </ul>
      )}

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && deleting) return
          if (!open) setPending(null)
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            triggerRef.current?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending === null
                ? 'Delete this copy?'
                : `Delete this device's copy of ${pending.label}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {DESTRUCTIVE_COPY['delete-replica-copy'](pending?.label ?? '')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            {/* Not AlertDialogAction: it closes on click, and the dialog has
                to stay open until the two-step delete settles. */}
            <Button
              type="button"
              variant="destructive"
              disabled={deleting}
              onClick={() => {
                if (pending !== null) void confirmDelete(pending)
              }}
            >
              Delete copy
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
