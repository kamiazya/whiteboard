import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Eraser, HardDrive, Library, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { apiFetch } from '../lib/api-client.js'
import { formatBytes } from '../lib/format-bytes.js'
import {
  storageReportPayloadSchema,
  type StorageBucket,
  type StorageReportPayload,
} from '../../shared/api-contracts/canvas.js'

interface UserLibraryRow {
  name: string
  path: string
  itemCount: number
  bytes?: number | null
}

// Storage starts as visibility-before-enforcement: rows expose where bytes are
// accumulating before the app applies caps, LRU, or category-specific cleanup.
// Each category keeps a stable row hook and reserved action slot so future
// Optimize / Cleanup controls can target the exact object they act on.

interface CategoryDescriptor {
  key: string
  label: string
  description: string
  // Optional soft cap. When the row's bytes pass this threshold the row
  // surfaces a "near / over cap" hint. No auto-prune happens here; this
  // component only makes growth visible before any cleanup policy runs.
  softCapBytes?: number
}

const USER_LIBRARIES_SOFT_CAP_BYTES = 50 * 1024 * 1024

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
  // Pinned to the bottom — user libraries are explicit user data, not
  // generated artefacts, and have their own management dialog.
  {
    key: 'libraries',
    label: 'User libraries',
    description: 'Excalidraw library packs you installed',
    softCapBytes: USER_LIBRARIES_SOFT_CAP_BYTES,
  },
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

function humanizeAge(seconds: number): string {
  if (seconds < 30) return 'just now'
  if (seconds < 60) return 'less than a minute ago'
  if (seconds < 3600) return RELATIVE_TIME_FORMAT.format(-Math.round(seconds / 60), 'minute')
  if (seconds < 86_400) return RELATIVE_TIME_FORMAT.format(-Math.round(seconds / 3600), 'hour')
  return RELATIVE_TIME_FORMAT.format(-Math.round(seconds / 86_400), 'day')
}

export function StorageReportCard() {
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
  // Every setTimeout this component schedules (status-clear timers, the
  // min-refresh-delay floor) is tracked here so unmount can clear it —
  // otherwise the timer keeps the event loop (and, in tests, fake-timer
  // bookkeeping) alive past teardown even though mountedRef already makes
  // its callback a no-op.
  const pendingTimeoutIdsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const id of pendingTimeoutIdsRef.current) {
        clearTimeout(id)
      }
      pendingTimeoutIdsRef.current.clear()
    }
  }, [])

  // Clear a transient action status after STATUS_CLEAR_MS, skipping the
  // setState if the component unmounted while the timer was pending.
  const scheduleStatusClear = useCallback((clear: () => void) => {
    const id = setTimeout(() => {
      pendingTimeoutIdsRef.current.delete(id)
      if (mountedRef.current) clear()
    }, STATUS_CLEAR_MS)
    pendingTimeoutIdsRef.current.add(id)
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
    try {
      const res = await apiFetch('/api/runtime/storage')
      if (!mountedRef.current) return
      if (!res.ok) {
        setError(`HTTP ${res.status}`)
        return
      }
      const json = storageReportPayloadSchema.parse(await res.json())
      if (!mountedRef.current) return
      setReport(json)
      setUpdatedAt(Date.now())
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      const elapsed = Date.now() - start
      const remaining = MIN_REFRESH_MS - elapsed
      if (remaining > 0) {
        // Bare `setTimeout`, not `window.setTimeout` — this line can resume
        // after a suspended await once jsdom's `window` has already been
        // torn down (see the sibling unmount test), and referencing the
        // `window` identifier at that point throws "window is not defined".
        // The global `setTimeout` binding survives that teardown.
        await new Promise<void>((resolve) => {
          const id = setTimeout(() => {
            pendingTimeoutIdsRef.current.delete(id)
            resolve()
          }, remaining)
          pendingTimeoutIdsRef.current.add(id)
        })
      }
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Optimize all canvases across every workspace. Loops sequentially so the
  // doc-cache eviction inside each compact stays coherent. Refreshes the
  // storage report at the end so the user sees the new totals without a
  // separate Refresh click.
  const [optimizing, setOptimizing] = useState(false)
  const [optimizeStatus, setOptimizeStatus] = useState<string | null>(null)
  const optimizeAll = useCallback(async () => {
    setOptimizing(true)
    setOptimizeStatus('Optimizing…')
    try {
      const wsRes = await apiFetch('/api/workspaces')
      if (!mountedRef.current) return
      if (!wsRes.ok) {
        setOptimizeStatus('Optimize failed')
        return
      }
      const { workspaces } = (await wsRes.json()) as {
        workspaces: Array<{ workspaceId: string }>
      }
      let savings = 0
      for (const { workspaceId } of workspaces) {
        const res = await apiFetch(`/api/workspaces/${workspaceId}/canvases/optimize-all`, {
          method: 'POST',
        })
        if (!res.ok) continue
        const body = (await res.json()) as {
          totalBeforeBytes: number
          totalAfterBytes: number
        }
        savings += body.totalBeforeBytes - body.totalAfterBytes
      }
      if (!mountedRef.current) return
      setOptimizeStatus(savings > 0 ? `Saved ${formatBytes(savings)}` : 'Already optimal')
      void refresh()
    } catch {
      if (mountedRef.current) setOptimizeStatus('Optimize failed')
    } finally {
      if (mountedRef.current) {
        setOptimizing(false)
        scheduleStatusClear(() => setOptimizeStatus(null))
      }
    }
  }, [refresh, scheduleStatusClear])

  // User libraries management dialog. Surfaces installed libraries with
  // per-pack size and item count, plus a per-row Remove that maps to the
  // existing DELETE /api/user-libraries/:name endpoint.
  const [libsOpen, setLibsOpen] = useState(false)
  const [libsLoading, setLibsLoading] = useState(false)
  const [libs, setLibs] = useState<UserLibraryRow[]>([])
  const [libsError, setLibsError] = useState<string | null>(null)
  const fetchLibs = useCallback(async () => {
    setLibsLoading(true)
    setLibsError(null)
    try {
      const res = await apiFetch('/api/user-libraries')
      if (!mountedRef.current) return
      if (!res.ok) {
        setLibsError(`HTTP ${res.status}`)
        return
      }
      const json = (await res.json()) as { libraries: UserLibraryRow[] }
      if (!mountedRef.current) return
      setLibs(json.libraries)
    } catch (err) {
      if (mountedRef.current) {
        setLibsError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (mountedRef.current) setLibsLoading(false)
    }
  }, [])
  const removeLib = useCallback(
    async (name: string) => {
      const res = await apiFetch(`/api/user-libraries/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      })
      if (!mountedRef.current) return
      if (!res.ok) {
        setLibsError(`Remove failed: HTTP ${res.status}`)
        return
      }
      // Optimistic update so the row disappears immediately, then re-pull
      // from the server to stay consistent with whatever else changed
      // (timestamps etc.).
      setLibs((prev) => prev.filter((l) => l.name !== name))
      void fetchLibs()
      void refresh()
    },
    [fetchLibs, refresh],
  )

  // Daemon-log rotation override. Logs are also pruned fire-and-forget
  // on every daemon startup; this button lets the user reclaim disk
  // without bouncing the daemon.
  const [pruningLogs, setPruningLogs] = useState(false)
  const [pruneLogsStatus, setPruneLogsStatus] = useState<string | null>(null)
  const pruneOldLogs = useCallback(async () => {
    setPruningLogs(true)
    setPruneLogsStatus('Pruning…')
    try {
      const res = await apiFetch('/api/runtime/logs/prune', { method: 'POST' })
      if (!mountedRef.current) return
      if (!res.ok) {
        setPruneLogsStatus('Prune failed')
        return
      }
      const body = (await res.json()) as { purgedCount: number; purgedBytes: number }
      if (!mountedRef.current) return
      setPruneLogsStatus(
        body.purgedCount > 0
          ? `Removed ${body.purgedCount} (${formatBytes(body.purgedBytes)})`
          : 'Nothing to prune',
      )
      void refresh()
    } catch {
      if (mountedRef.current) setPruneLogsStatus('Prune failed')
    } finally {
      if (mountedRef.current) {
        setPruningLogs(false)
        scheduleStatusClear(() => setPruneLogsStatus(null))
      }
    }
  }, [refresh, scheduleStatusClear])

  // Sandwiched auto-version prune. Manual versions are explicit user
  // save-points; autos between any two manuals add no rollback value and
  // can be safely dropped. Same iterating pattern as Optimize all.
  const [pruningVersions, setPruningVersions] = useState(false)
  const [pruneVersionsStatus, setPruneVersionsStatus] = useState<string | null>(null)
  const pruneSandwichedAutoVersions = useCallback(async () => {
    setPruningVersions(true)
    setPruneVersionsStatus('Cleaning…')
    try {
      const wsRes = await apiFetch('/api/workspaces')
      if (!mountedRef.current) return
      if (!wsRes.ok) {
        setPruneVersionsStatus('Cleanup failed')
        return
      }
      const { workspaces } = (await wsRes.json()) as {
        workspaces: Array<{ workspaceId: string }>
      }
      let totalDeleted = 0
      for (const { workspaceId } of workspaces) {
        const res = await apiFetch(`/api/workspaces/${workspaceId}/versions/prune-sandwiched`, {
          method: 'POST',
        })
        if (!res.ok) continue
        const body = (await res.json()) as { totalDeleted: number }
        totalDeleted += body.totalDeleted
      }
      if (!mountedRef.current) return
      setPruneVersionsStatus(
        totalDeleted > 0 ? `Removed ${totalDeleted} auto-version(s)` : 'Nothing to clean',
      )
      void refresh()
    } catch {
      if (mountedRef.current) setPruneVersionsStatus('Cleanup failed')
    } finally {
      if (mountedRef.current) {
        setPruningVersions(false)
        scheduleStatusClear(() => setPruneVersionsStatus(null))
      }
    }
  }, [refresh, scheduleStatusClear])

  // Dangling-files cleanup. Same workspace-iterating pattern as Optimize
  // all — call the per-workspace purge endpoint, sum the freed bytes, and
  // refresh the storage report so the row total updates immediately.
  const [cleaningFiles, setCleaningFiles] = useState(false)
  const [cleanFilesStatus, setCleanFilesStatus] = useState<string | null>(null)
  const cleanupDanglingFiles = useCallback(async () => {
    setCleaningFiles(true)
    setCleanFilesStatus('Cleaning…')
    try {
      const wsRes = await apiFetch('/api/workspaces')
      if (!mountedRef.current) return
      if (!wsRes.ok) {
        setCleanFilesStatus('Cleanup failed')
        return
      }
      const { workspaces } = (await wsRes.json()) as {
        workspaces: Array<{ workspaceId: string }>
      }
      let purgedBytes = 0
      let purgedCount = 0
      for (const { workspaceId } of workspaces) {
        const res = await apiFetch(`/api/workspaces/${workspaceId}/files/purge-dangling`, {
          method: 'POST',
        })
        if (!res.ok) continue
        const body = (await res.json()) as { purgedCount: number; purgedBytes: number }
        purgedBytes += body.purgedBytes
        purgedCount += body.purgedCount
      }
      if (!mountedRef.current) return
      setCleanFilesStatus(
        purgedCount > 0
          ? `Removed ${purgedCount} (${formatBytes(purgedBytes)})`
          : 'Nothing to clean',
      )
      void refresh()
    } catch {
      if (mountedRef.current) setCleanFilesStatus('Cleanup failed')
    } finally {
      if (mountedRef.current) {
        setCleaningFiles(false)
        scheduleStatusClear(() => setCleanFilesStatus(null))
      }
    }
  }, [refresh, scheduleStatusClear])

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

      {error && <div className="text-xs text-destructive">Error: {error}</div>}

      <ul className="rounded-lg border divide-y">
        {CATEGORIES.map(({ key, label, description, softCapBytes }) => {
          const bucket = report?.byCategory[key] ?? { bytes: 0, files: 0 }
          const overCap = softCapBytes !== undefined && bucket.bytes > softCapBytes
          const nearCap =
            !overCap && softCapBytes !== undefined && bucket.bytes > softCapBytes * 0.8
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
                  {overCap
                    ? 'Over soft cap — please uninstall unused'
                    : nearCap
                      ? 'Approaching soft cap'
                      : `${bucket.files} files`}
                </div>
              </div>
              {/* Reserved action slot. Today only the Canvas snapshots row
                  carries an action (Optimize all → compact Loro op-log on
                  every canvas across every workspace). Other rows keep an
                  empty same-width slot so future additions do not nudge
                  other rows. */}
              <div
                className="shrink-0 min-w-[2.25rem] flex flex-col items-end gap-0.5"
                data-storage-actions={key}
              >
                {key === 'blobs' && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5"
                      onClick={() => void optimizeAll()}
                      disabled={optimizing}
                      aria-label="Optimize all canvases"
                    >
                      <Sparkles className={optimizing ? 'size-3.5 animate-pulse' : 'size-3.5'} />
                      <span className="text-xs">{optimizing ? 'Optimizing…' : 'Optimize'}</span>
                    </Button>
                    <span className="text-[10px] text-muted-foreground">
                      {/* Prefer the freshest signal: a transient
                          optimizeStatus from the user's last click wins
                          over the persisted lastAutoCompactedAt timestamp. */}
                      {optimizeStatus ??
                        (report?.lastAutoCompactedAt
                          ? `Auto-optimised ${humanizeAge(
                              Math.max(0, Math.floor((now - report.lastAutoCompactedAt) / 1000)),
                            )}`
                          : 'Never auto-optimised')}
                    </span>
                  </>
                )}
                {key === 'versions' && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5"
                      onClick={() => void pruneSandwichedAutoVersions()}
                      disabled={pruningVersions}
                      aria-label="Cleanup sandwiched auto-versions"
                    >
                      <Eraser className={pruningVersions ? 'size-3.5 animate-pulse' : 'size-3.5'} />
                      <span className="text-xs">{pruningVersions ? 'Cleaning…' : 'Cleanup'}</span>
                    </Button>
                    {pruneVersionsStatus && (
                      <span className="text-[10px] text-muted-foreground">
                        {pruneVersionsStatus}
                      </span>
                    )}
                  </>
                )}
                {key === 'files' && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5"
                      onClick={() => void cleanupDanglingFiles()}
                      disabled={cleaningFiles}
                      aria-label="Clean up dangling files"
                    >
                      <Eraser className={cleaningFiles ? 'size-3.5 animate-pulse' : 'size-3.5'} />
                      <span className="text-xs">{cleaningFiles ? 'Cleaning…' : 'Cleanup'}</span>
                    </Button>
                    {cleanFilesStatus && (
                      <span className="text-[10px] text-muted-foreground">{cleanFilesStatus}</span>
                    )}
                  </>
                )}
                {key === 'logs' && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5"
                      onClick={() => void pruneOldLogs()}
                      disabled={pruningLogs}
                      aria-label="Prune old daemon logs"
                    >
                      <Eraser className={pruningLogs ? 'size-3.5 animate-pulse' : 'size-3.5'} />
                      <span className="text-xs">{pruningLogs ? 'Pruning…' : 'Cleanup'}</span>
                    </Button>
                    {pruneLogsStatus && (
                      <span className="text-[10px] text-muted-foreground">{pruneLogsStatus}</span>
                    )}
                  </>
                )}
                {key === 'libraries' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5"
                    onClick={() => {
                      setLibsOpen(true)
                      void fetchLibs()
                    }}
                    aria-label="Manage installed user libraries"
                  >
                    <Library className="size-3.5" />
                    <span className="text-xs">Manage</span>
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      <Dialog
        open={libsOpen}
        onOpenChange={(next) => {
          setLibsOpen(next)
          if (!next) setLibsError(null)
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>User libraries</DialogTitle>
            <DialogDescription>
              Installed Excalidraw library packs. Removing a pack deletes its{' '}
              <code>.excalidrawlib</code> file from disk and drops the registry row — canvases that
              referenced it keep their embedded copies of any item already inserted.
            </DialogDescription>
          </DialogHeader>
          {libsLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : libs.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No user libraries installed.
            </div>
          ) : (
            <ul className="rounded-md border divide-y max-h-[60vh] overflow-y-auto">
              {libs.map((lib) => (
                <li
                  key={lib.name}
                  className="flex items-center gap-3 px-3 py-2"
                  data-user-library-row={lib.name}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{lib.name}</div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {lib.itemCount} item{lib.itemCount === 1 ? '' : 's'}
                      {typeof lib.bytes === 'number'
                        ? ` · ${formatBytes(lib.bytes)}`
                        : lib.bytes === null
                          ? ' · file missing'
                          : ''}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-destructive hover:text-destructive"
                    onClick={() => void removeLib(lib.name)}
                    aria-label={`Remove user library ${lib.name}`}
                  >
                    <Trash2 className="size-3.5" />
                    <span className="text-xs">Remove</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {libsError && <div className="text-xs text-destructive">{libsError}</div>}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void fetchLibs()}
              disabled={libsLoading}
            >
              Refresh
            </Button>
            <Button type="button" onClick={() => setLibsOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
