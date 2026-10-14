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
 * daemon) already has its own path in `browser-workspace-removal.ts`. The row
 * still appears, because a list of "every copy" that silently omits half of
 * them is worse than no list.
 */
import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { DaemonApiContext } from '../../contexts/DaemonApiContext.js'
import { getAppLogger } from '../../lib/app-logger.js'
import { DESTRUCTIVE_COPY } from '../../lib/destructive-copy.js'
import { formatRelative } from '../../lib/format-relative.js'
import { listReplicas, type ReplicaMatch } from '../../lib/replicas.js'
import type { UserSettingsStore } from '../../lib/user-settings-store.js'
import { workspaceLabel } from '../../lib/workspace-handle.js'
import { DaemonAddress } from '../connection/DaemonAddress.js'
import { Button } from '../ui/button.js'
import { PinnedConfirmDialog } from '../ui/pinned-confirm-dialog.js'
import { ReplicaOfflineControl } from './ReplicaOfflineControl.js'

const log = getAppLogger('local-copies')

/** What a row needs, whichever set it came from. */
interface CopyRow {
  workspaceId: string
  /** What to call it — `workspaceLabel` of whatever record the row came from. */
  label: string
  keeper: 'browser' | 'daemon'
  /** For a browser-kept row: how many documents it holds, once counted. */
  documentCount?: number
  /** Present for a replica: which daemon keeps the original. */
  daemonBaseUrl?: string
  syncedAt?: string
}

function replicaRow(entry: ReplicaMatch): CopyRow {
  return {
    workspaceId: entry.workspaceId,
    label: workspaceLabel(entry),
    keeper: 'daemon',
    daemonBaseUrl: entry.daemonBaseUrl,
    syncedAt: entry.syncedAt,
  }
}

/**
 * What a browser-kept row says, by what it holds. An empty workspace is the
 * only copy of nothing, so it says it is empty rather than warning about a
 * loss that cannot happen — the case a demote leaves when it moved the last
 * browser workspace and a fresh one took its name beside the daemon's.
 */
function browserKeptCopy(documentCount: number | undefined): string {
  if (documentCount === 0) return 'Kept in this browser, and empty.'
  const noun = documentCount === 1 ? 'document' : 'documents'
  const holds = documentCount === undefined ? '' : `, holding ${documentCount} ${noun}`
  return `Kept in this browser${holds} — the only copy of it anywhere, so it cannot be removed here.`
}

function CopyRowDescription({ row }: { row: CopyRow }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm">{row.label}</span>
      <span className="text-muted-foreground text-xs">
        {row.keeper === 'browser' ? (
          browserKeptCopy(row.documentCount)
        ) : (
          <>
            Cached from <DaemonAddress baseUrl={row.daemonBaseUrl ?? ''} />
            {row.syncedAt === undefined ? '' : ` · synced ${formatRelative(row.syncedAt)}`}
          </>
        )}
      </span>
    </div>
  )
}

/** One row. `onDelete` is handed the button so the card can restore focus
 *  to it after the dialog closes — one dialog serves every row, so there is
 *  no `AlertDialogTrigger` to do that for us. */
function CopyRowItem({
  row,
  openHere,
  onDelete,
  daemonFetch,
}: {
  row: CopyRow
  openHere: boolean
  onDelete: (trigger: HTMLButtonElement) => void
  /** A fetch to this row's daemon while it is the connected one, else null. */
  daemonFetch: typeof globalThis.fetch | null
}) {
  return (
    <li data-testid={`local-copy-${row.workspaceId}`} className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-3">
        <CopyRowDescription row={row} />
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
      </div>
      {row.keeper === 'daemon' && row.daemonBaseUrl !== undefined && (
        <ReplicaOfflineControl
          daemonBaseUrl={row.daemonBaseUrl}
          workspaceId={row.workspaceId}
          label={row.label}
          daemonFetch={daemonFetch}
        />
      )}
    </li>
  )
}

function withDocumentCount(row: CopyRow, counts: ReadonlyMap<string, number>): CopyRow {
  const documentCount = row.keeper === 'browser' ? counts.get(row.workspaceId) : undefined
  return documentCount === undefined ? row : { ...row, documentCount }
}

/**
 * How many documents each browser-kept workspace holds, or `undefined` when
 * they cannot be counted. A count reads every workspace's tree, which loads
 * loro-crdt's WASM, so it is imported only when there is a row to count.
 */
async function readBrowserDocumentCounts(): Promise<ReadonlyMap<string, number> | undefined> {
  try {
    const { browserDocumentCounts } = await import('../../lib/browser-document-counts.js')
    return await browserDocumentCounts()
  } catch (error) {
    log.info('the browser workspaces could not be counted', error)
    return undefined
  }
}

/** Every copy this device keeps, read from the two sources that list them; `load` re-reads. */
function useCopyRows(settingsStore: UserSettingsStore) {
  const [rows, setRows] = useState<CopyRow[] | null>(null)
  const [keptReadable, setKeptReadable] = useState(true)
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map())

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
        label: workspaceLabel(entry),
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
    if (kept.length === 0) return
    // After the rows are drawn, and held apart from them: a count landing
    // after a later re-read must not put back a row that re-read dropped.
    const counted = await readBrowserDocumentCounts()
    if (counted !== undefined) setCounts(counted)
  }, [settingsStore])

  useEffect(() => {
    void load()
  }, [load])

  const counted = useMemo(
    () => (rows === null ? null : rows.map((row) => withDocumentCount(row, counts))),
    [rows, counts],
  )
  return { rows: counted, keptReadable, load }
}

export function LocalCopiesCard({
  settingsStore,
  workspaceId,
  daemonBaseUrl,
}: {
  settingsStore: UserSettingsStore
  /** The workspace this session is showing, if any — its copy cannot be
   *  deleted from under the page that is reading it. */
  workspaceId?: string
  /** The daemon this session is connected to, whose fetch the provider above
   *  carries — what lets that daemon's copies be made readable offline. */
  daemonBaseUrl?: string
}) {
  const headingId = useId()
  const daemonApi = useContext(DaemonApiContext)
  const [pending, setPending] = useState<CopyRow | null>(null)
  const [deleting, setDeleting] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const { rows, keptReadable, load } = useCopyRows(settingsStore)

  const confirmDelete = useCallback(
    async (row: CopyRow) => {
      setDeleting(true)
      try {
        const { forgetReplicaCopy } = await import('../../lib/browser-workspace-removal.js')
        await forgetReplicaCopy(settingsStore, row.workspaceId, row.daemonBaseUrl)
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
              daemonFetch={
                daemonApi !== null && row.daemonBaseUrl === daemonBaseUrl ? daemonApi : null
              }
              onDelete={(trigger) => {
                triggerRef.current = trigger
                setPending(row)
              }}
            />
          ))}
        </ul>
      )}

      <PinnedConfirmDialog
        open={pending !== null}
        busy={deleting}
        title={
          pending === null ? 'Delete this copy?' : `Delete this device's copy of ${pending.label}?`
        }
        description={DESTRUCTIVE_COPY['delete-replica-copy'](pending?.label ?? '')}
        confirmLabel="Delete copy"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending !== null) void confirmDelete(pending)
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          triggerRef.current?.focus()
        }}
      />
    </section>
  )
}
