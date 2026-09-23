import {
  optimizeAllDocumentsResponseSchema,
  pruneSandwichedVersionsResponseSchema,
  purgeResultSchema,
  type StorageCategory,
  type StorageReportPayload,
  storageReportPayloadSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { Eraser, HardDrive, RefreshCw, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../components/ui/button.js'
import { useDaemonApi } from '../contexts/DaemonApiContext.js'
import { formatBytes } from '../lib/format-bytes.js'
import { sweepWorkspaces, useMaintenanceRunner } from './storage-maintenance.js'
import {
  type CategoryDescriptor,
  type RowAction,
  StorageCategoryRow,
} from './storage-report-rows.js'

// Storage starts as visibility-before-enforcement: rows expose where bytes are
// accumulating before the app applies caps, LRU, or category-specific cleanup.
// Each category keeps a stable row hook and reserved action slot so future
// Optimize / Cleanup controls can target the exact object they act on.

const CATEGORIES: CategoryDescriptor[] = [
  { key: 'blobs', label: 'Canvas snapshots', description: 'Latest Loro doc per canvas' },
  {
    key: 'versions',
    label: 'Versions',
    description: 'Saved version history (manual + auto)',
  },
  { key: 'files', label: 'Uploaded files', description: 'Image / asset uploads' },
  { key: 'exports', label: 'Exports', description: 'PNG / JSON files you exported' },
  { key: 'logs', label: 'Logs', description: 'Daemon stdout / stderr archives' },
  { key: 'db', label: 'Metadata DB', description: 'Workspaces, names, pins, branches' },
  { key: 'other', label: 'Other', description: 'Unclassified files in the data dir' },
]

// Show the spinner for at least this long even if fetch returns sooner —
// otherwise on a fast network the click is invisible.
const MIN_REFRESH_MS = 400

// How long a transient action status ("Saved 2 KiB", "Nothing to prune")
// lingers on its row before clearing. Exported so tests can size their
// unmount-during-pending-timer waits without duplicating the constant.
export const STATUS_CLEAR_MS = 3000

// Coarse-grained interval. We do not need second-by-second updates because
// the humanized string only changes at 30s / 1m / 1h boundaries; a 30s
// re-render is enough to keep the display fresh without flickering.
const HUMANIZE_TICK_MS = 30_000

// Humanize an age expressed in seconds. Sub-30s collapses to "just now" so
// the display does not flicker once-per-second when the user just hit
// Refresh; the Intl primitive handles plurals and tense for the rest. No
// new dependency — Intl.RelativeTimeFormat ships with Node and modern
// browsers.
const RELATIVE_TIME_FORMAT = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

// Workspace-iterating cleanup actions (optimizeAll, pruneSandwichedAutoVersions,
// cleanupDanglingFiles) skip any workspace whose per-workspace request fails
// and keep aggregating the rest, so a status built only from the successful
// totals would tell the user everything succeeded even when some workspaces
// were left untouched. Appending this note keeps the aggregation resilient
// (partial progress still counts) while surfacing that the job was partial.
function appendPartialFailureNote(status: string, failedWorkspaces: number): string {
  if (failedWorkspaces <= 0) return status
  return `${status} (${failedWorkspaces} workspace${failedWorkspaces === 1 ? '' : 's'} failed)`
}

function humanizeAge(seconds: number): string {
  if (seconds < 30) return 'just now'
  if (seconds < 60) return 'less than a minute ago'
  if (seconds < 3600) return RELATIVE_TIME_FORMAT.format(-Math.round(seconds / 60), 'minute')
  if (seconds < 86_400) return RELATIVE_TIME_FORMAT.format(-Math.round(seconds / 3600), 'hour')
  return RELATIVE_TIME_FORMAT.format(-Math.round(seconds / 86_400), 'day')
}

/** The storage report, or the reason it could not be read. */
async function readStorageReport(
  fetchApi: typeof globalThis.fetch,
): Promise<{ report: StorageReportPayload } | { error: string }> {
  try {
    const res = await fetchApi('/api/runtime/storage')
    if (!res.ok) return { error: `HTTP ${res.status}` }
    return { report: storageReportPayloadSchema.parse(await res.json()) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Wait out whatever is left of a floor, and nothing when it has passed. */
async function holdUntil(deadline: number): Promise<void> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return
  await new Promise((resolve) => setTimeout(resolve, remaining))
}

export function StorageReportCard() {
  // Falls back to the same-origin apiFetch when no DaemonApiContext provider
  // is mounted, so mcp-server / same-origin usage is unchanged.
  const fetchApi = useDaemonApi()
  const [report, setReport] = useState<StorageReportPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // Every handler below is async and resumes after an await to call
  // setState. If the component unmounts mid-flight (a fast test teardown,
  // or the user navigating away before a fetch/min-refresh delay settles),
  // that resumed setState can outlive the component. Guard every
  // post-await setState with this ref instead of relying on React to no-op
  // the call safely — a live jsdom `window` makes an unmounted-root
  // setState harmless, but if the environment itself is torn down before
  // the callback resumes (e.g. end-of-test-file jsdom teardown racing a
  // pending setTimeout), the same call throws.
  const mountedRef = useRef(true)
  // Every id here is a still-pending scheduleStatusClear timeout. Cleared on
  // unmount so none of them can fire after the environment that scheduled
  // them (e.g. a jsdom `window`) is gone — the mountedRef guard alone stops
  // the resulting setState, but not the timer callback itself from running
  // and touching globals that may no longer exist.
  const pendingStatusClearIds = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const id of pendingStatusClearIds.current) {
        clearTimeout(id)
      }
      pendingStatusClearIds.current.clear()
    }
  }, [])

  // Clear a transient action status after STATUS_CLEAR_MS, skipping the
  // setState if the component unmounted while the timer was pending.
  const scheduleStatusClear = useCallback((clear: () => void) => {
    const id = setTimeout(() => {
      pendingStatusClearIds.current.delete(id)
      if (mountedRef.current) clear()
    }, STATUS_CLEAR_MS)
    pendingStatusClearIds.current.add(id)
  }, [])

  // Coarse tick so the "Updated …" / "Auto-optimised …" lines stay live
  // without flickering second-by-second. Humanized strings only change at
  // 30s / 1m / 1h boundaries, so a 30s re-render is plenty.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), HUMANIZE_TICK_MS)
    return () => clearInterval(id)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    const start = Date.now()
    const read = await readStorageReport(fetchApi)
    if (mountedRef.current) {
      if ('error' in read) setError(read.error)
      else {
        setReport(read.report)
        setUpdatedAt(Date.now())
      }
    }
    // The spinner is held to a floor so a fast answer still reads as an
    // action that happened, rather than as a button that did nothing.
    await holdUntil(start + MIN_REFRESH_MS)
    if (mountedRef.current) setLoading(false)
  }, [fetchApi])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runMaintenance = useMaintenanceRunner(mountedRef, scheduleStatusClear, refresh)

  // Optimize all documents across every workspace. Loops sequentially so the
  // doc-cache eviction inside each compact stays coherent. Refreshes the
  // storage report at the end so the user sees the new totals without a
  // separate Refresh click.
  const [optimizing, setOptimizing] = useState(false)
  const [optimizeStatus, setOptimizeStatus] = useState<string | null>(null)
  const optimizeAll = useCallback(
    () =>
      runMaintenance({
        setBusy: setOptimizing,
        setStatus: setOptimizeStatus,
        running: 'Optimizing…',
        failed: 'Optimize failed',
        run: async () => {
          const swept = await sweepWorkspaces(
            fetchApi,
            (workspaceId) => `/api/workspaces/${workspaceId}/documents/optimize-all`,
            (saved, body) => {
              const parsed = optimizeAllDocumentsResponseSchema.parse(body)
              return saved + (parsed.totalBeforeBytes - parsed.totalAfterBytes)
            },
            0,
          )
          if (swept === null) return null
          return appendPartialFailureNote(
            swept.total > 0 ? `Saved ${formatBytes(swept.total)}` : 'Already optimal',
            swept.failedWorkspaces,
          )
        },
      }),
    [runMaintenance, fetchApi],
  )

  // Daemon-log rotation override. Logs are also pruned fire-and-forget
  // on every daemon startup; this button lets the user reclaim disk
  // without bouncing the daemon.
  const [pruningLogs, setPruningLogs] = useState(false)
  const [pruneLogsStatus, setPruneLogsStatus] = useState<string | null>(null)
  const pruneOldLogs = useCallback(
    () =>
      runMaintenance({
        setBusy: setPruningLogs,
        setStatus: setPruneLogsStatus,
        running: 'Pruning…',
        failed: 'Prune failed',
        run: async () => {
          const res = await fetchApi('/api/runtime/logs/prune', { method: 'POST' })
          if (!res.ok) return null
          const body = purgeResultSchema.parse(await res.json())
          return body.purgedCount > 0
            ? `Removed ${body.purgedCount} (${formatBytes(body.purgedBytes)})`
            : 'Nothing to prune'
        },
      }),
    [runMaintenance, fetchApi],
  )

  // Sandwiched auto-version prune. Manual versions are explicit user
  // save-points; autos between any two manuals add no rollback value and
  // can be safely dropped. Same iterating pattern as Optimize all.
  const [pruningVersions, setPruningVersions] = useState(false)
  const [pruneVersionsStatus, setPruneVersionsStatus] = useState<string | null>(null)
  const pruneSandwichedAutoVersions = useCallback(
    () =>
      runMaintenance({
        setBusy: setPruningVersions,
        setStatus: setPruneVersionsStatus,
        running: 'Cleaning…',
        failed: 'Cleanup failed',
        run: async () => {
          const swept = await sweepWorkspaces(
            fetchApi,
            (workspaceId) => `/api/workspaces/${workspaceId}/versions/prune-sandwiched`,
            (deleted, body) =>
              deleted + pruneSandwichedVersionsResponseSchema.parse(body).totalDeleted,
            0,
          )
          if (swept === null) return null
          return appendPartialFailureNote(
            swept.total > 0 ? `Removed ${swept.total} auto-version(s)` : 'Nothing to clean',
            swept.failedWorkspaces,
          )
        },
      }),
    [runMaintenance, fetchApi],
  )

  // Dangling-files cleanup. Same workspace-iterating pattern as Optimize
  // all — call the per-workspace purge endpoint, sum the freed bytes, and
  // refresh the storage report so the row total updates immediately.
  const [cleaningFiles, setCleaningFiles] = useState(false)
  const [cleanFilesStatus, setCleanFilesStatus] = useState<string | null>(null)
  const cleanupDanglingFiles = useCallback(
    () =>
      runMaintenance({
        setBusy: setCleaningFiles,
        setStatus: setCleanFilesStatus,
        running: 'Cleaning…',
        failed: 'Cleanup failed',
        run: async () => {
          const swept = await sweepWorkspaces(
            fetchApi,
            (workspaceId) => `/api/workspaces/${workspaceId}/files/purge-dangling`,
            (acc, body) => {
              const parsed = purgeResultSchema.parse(body)
              return {
                bytes: acc.bytes + parsed.purgedBytes,
                count: acc.count + parsed.purgedCount,
              }
            },
            { bytes: 0, count: 0 },
          )
          if (swept === null) return null
          return appendPartialFailureNote(
            swept.total.count > 0
              ? `Removed ${swept.total.count} (${formatBytes(swept.total.bytes)})`
              : 'Nothing to clean',
            swept.failedWorkspaces,
          )
        },
      }),
    [runMaintenance, fetchApi],
  )

  // One entry per row that HAS a control. A row with no entry still gets the
  // reserved slot, so adding one later does not nudge the others.
  const rowActions: Partial<Record<StorageCategory, RowAction>> = {
    blobs: {
      icon: Sparkles,
      idleLabel: 'Optimize',
      busyLabel: 'Optimizing…',
      ariaLabel: 'Optimize all documents',
      busy: optimizing,
      run: () => void optimizeAll(),
      // Prefer the freshest signal: a transient status from the user's last
      // click wins over the persisted lastAutoCompactedAt timestamp.
      status:
        optimizeStatus ??
        (report?.lastAutoCompactedAt
          ? `Auto-optimised ${humanizeAge(
              Math.max(0, Math.floor((now - report.lastAutoCompactedAt) / 1000)),
            )}`
          : 'Never auto-optimised'),
    },
    versions: {
      icon: Eraser,
      idleLabel: 'Cleanup',
      busyLabel: 'Cleaning…',
      ariaLabel: 'Cleanup sandwiched auto-versions',
      busy: pruningVersions,
      run: () => void pruneSandwichedAutoVersions(),
      status: pruneVersionsStatus,
    },
    files: {
      icon: Eraser,
      idleLabel: 'Cleanup',
      busyLabel: 'Cleaning…',
      ariaLabel: 'Clean up dangling files',
      busy: cleaningFiles,
      run: () => void cleanupDanglingFiles(),
      status: cleanFilesStatus,
    },
    logs: {
      icon: Eraser,
      idleLabel: 'Cleanup',
      busyLabel: 'Pruning…',
      ariaLabel: 'Prune old daemon logs',
      busy: pruningLogs,
      run: () => void pruneOldLogs(),
      status: pruneLogsStatus,
    },
  }

  const ageSeconds = updatedAt === null ? null : Math.max(0, Math.floor((now - updatedAt) / 1000))

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <HardDrive className="size-4 text-muted-foreground" />
          <div>
            <div className="text-sm font-medium">
              {report ? (
                <>
                  Total {formatBytes(report.totalBytes)}{' '}
                  <span className="text-muted-foreground font-normal">
                    · {report.fileCount} files
                  </span>
                </>
              ) : (
                'Storage usage'
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {ageSeconds === null ? 'Never updated' : `Updated ${humanizeAge(ageSeconds)}`}
            </div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label="Refresh storage usage"
        >
          <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          <span className="text-xs">{loading ? 'Refreshing…' : 'Refresh'}</span>
        </Button>
      </div>

      {error && (
        <div className="text-xs text-destructive">Couldn't load storage usage ({error}).</div>
      )}

      <ul className="rounded-lg border divide-y">
        {CATEGORIES.map((descriptor) => (
          <StorageCategoryRow
            key={descriptor.key}
            descriptor={descriptor}
            bucket={report?.byCategory[descriptor.key] ?? { bytes: 0, files: 0 }}
            action={rowActions[descriptor.key]}
          />
        ))}
      </ul>
    </div>
  )
}
