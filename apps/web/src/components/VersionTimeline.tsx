import {
  documentsApiUrl,
  listVersionsResponseSchema,
  type OperatorInfo,
  type VersionEntry,
} from '@kamiazya/whiteboard-mcp/api-contracts'
import { History } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDaemonApi } from '@/contexts/DaemonApiContext'
import { useBranches } from '@/hooks/useBranches'
import { getAppLogger } from '@/lib/app-logger'
import { buildMiniGraph } from '@/lib/mini-graph'
import { displayBranchName } from '@/lib/utils'
import { SquiggleLoader } from './SquiggleLoader.js'
import { VersionThumbnail } from './VersionThumbnail.js'

const log = getAppLogger('VersionTimeline')

interface Props {
  workspaceId: string
  path: string
  // Called after restore succeeds so the browser-side LoroUndoManager can be cleared.
  onRestored?: () => void
  // Bumped by the caller (e.g. after a manual "Save version" action, or a WS
  // version_created broadcast) to force a refetch without waiting for the
  // 15s poll. Only a value CHANGE triggers a refetch, matching
  // HeaderBranchChip's refreshSignal contract.
  refreshSignal?: number
}

// Render an ISO string as a short relative timestamp.
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return iso
  // Clamp: server clocks slightly ahead of the client would otherwise yield
  // "-5s ago".
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  const d = new Date(then)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// A version's display title: its explicit label, or a fallback naming its origin.
function versionTitle(version: Pick<VersionEntry, 'label' | 'auto'>): string {
  return version.label || (version.auto ? 'Auto-save' : 'Manual')
}

function getOperatorAffordance(operator?: OperatorInfo): { icon: string; label: string } {
  const kind = operator?.kind ?? 'system'
  const icon = kind === 'ai' ? '🤖' : kind === 'human' ? '👤' : '⚙'
  const label = operator?.displayName?.trim()
  if (label) return { icon, label }
  return {
    icon,
    label: kind === 'ai' ? 'AI' : kind === 'human' ? 'Human' : 'System',
  }
}

// Branch operations and save controls live in the header.
// VersionTimeline is responsible only for the version list, mini-graph, and restore flow.
/**
 * The card a version row sits in — a button where it can be restored, a plain
 * container where it cannot.
 *
 * Split by ELEMENT rather than by a `disabled` attribute: a disabled button
 * announces "unavailable", which is the wrong story about a row that is doing
 * its job (telling you what happened on another lane). There is nothing to
 * enable here later, so there is nothing to grey out.
 */
function RowShell({
  interactive,
  onActivate,
  children,
}: {
  readonly interactive: boolean
  readonly onActivate: () => void
  readonly children: ReactNode
}) {
  const shared =
    'bg-card text-card-foreground flex flex-1 min-w-0 flex-col gap-6 overflow-hidden rounded-xl border py-2 text-left shadow-sm'
  if (!interactive) {
    return <div className={`${shared} opacity-80`}>{children}</div>
  }
  return (
    <button
      type="button"
      className={`${shared} cursor-pointer transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`}
      onClick={onActivate}
    >
      {children}
    </button>
  )
}

export default function VersionTimeline({ workspaceId, path, onRestored, refreshSignal }: Props) {
  const fetchFn = useDaemonApi()
  const [versions, setVersions] = useState<VersionEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<VersionEntry | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [isRestoring, setIsRestoring] = useState(false)
  // Mirrors pendingRestore, refreshed on every render so confirmRestore's
  // async continuation can read the *current* pending version after an
  // await, instead of a value closed over before the request started.
  const pendingRestoreRef = useRef<VersionEntry | null>(pendingRestore)
  pendingRestoreRef.current = pendingRestore
  // Monotonically increasing sequence stamp. Each refresh() call captures the
  // value at dispatch time; a response only commits if no newer refresh has
  // started meanwhile. Without this, a slow /versions response for an older
  // workspaceId/path pair could overwrite the list after the canvas changed.
  const fetchSeqRef = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++fetchSeqRef.current
    setLoading(true)
    try {
      const res = await fetchFn(documentsApiUrl(workspaceId, path, 'versions'))
      if (seq !== fetchSeqRef.current) return
      if (res.ok) {
        const parsed = listVersionsResponseSchema.safeParse(await res.json())
        if (seq !== fetchSeqRef.current) return
        if (parsed.success) setVersions(parsed.data.versions)
        else {
          log.error('versions response failed schema validation', { workspaceId, path })
          setVersions([])
        }
      } else {
        log.error('versions request failed', { status: res.status, workspaceId, path })
      }
    } catch (err) {
      if (seq !== fetchSeqRef.current) return
      log.error('versions request threw', err)
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false)
    }
  }, [workspaceId, path, fetchFn])

  // Clear the previously loaded canvas's versions immediately on canvas
  // change so a stale row (with thumbnail URLs pointing at the old
  // workspaceId/path) never renders under the new canvas while the refetch
  // is in flight. Also drop any staged restore — confirming a dialog opened
  // on the previous canvas would POST that version id to the NEW canvas's
  // restore endpoint.
  useEffect(() => {
    setVersions([])
    setPendingRestore(null)
    setRestoreError(null)
    setIsRestoring(false)
  }, [workspaceId, path])

  // Reload whenever the canvas changes.
  useEffect(() => {
    refresh()
  }, [refresh])

  // Keep branch state here for head filtering and the mini-graph.
  // Legacy versions without branchName are treated as main.
  const {
    state: branchesState,
    loading: branchesLoading,
    refetch: refetchBranches,
  } = useBranches(workspaceId, path, fetchFn)

  // Poll every 15 seconds for new auto-versions, and re-fetch branches on the
  // same tick. useBranches has no event subscription of its own, so this is
  // the only path by which an externally-driven HEAD change (another peer
  // switching branches, a merge from another tab) reaches this component's
  // branch filter.
  useEffect(() => {
    const h = setInterval(() => {
      refresh()
      refetchBranches()
    }, 15_000)
    return () => clearInterval(h)
  }, [refresh, refetchBranches])

  // Only a CHANGE in refreshSignal triggers a refetch — the mount-triggered
  // refresh() effect above already covers the initial load, and this ref
  // guard keeps an unrelated re-render (e.g. a parent state update) from
  // refetching when the signal value itself hasn't moved.
  const prevRefreshSignalRef = useRef(refreshSignal)
  useEffect(() => {
    if (prevRefreshSignalRef.current === refreshSignal) return
    prevRefreshSignalRef.current = refreshSignal
    refresh()
  }, [refreshSignal, refresh])

  const confirmRestore = useCallback(async () => {
    // Guard against a double-click or repeated keyboard activation firing a
    // second /restore POST before the first response closes the dialog.
    if (!pendingRestore || isRestoring) return
    const v = pendingRestore
    setRestoreError(null)
    setIsRestoring(true)
    // Only clear the dialog and run success side effects (onRestored clears the
    // browser-side LoroUndoManager) once the server confirms the restore
    // actually happened. A failed request keeps the dialog open with an error
    // so the caller never discards undo history for a restore that didn't occur.
    try {
      const res = await fetchFn(documentsApiUrl(workspaceId, path, `versions/${v.id}/restore`), {
        method: 'POST',
      })
      if (!res.ok) {
        log.error('restore request failed', { status: res.status, versionId: v.id })
        setRestoreError('Restore failed. Please try again.')
        return
      }
    } catch (err) {
      log.error('restore request threw', err)
      setRestoreError('Restore failed. Please try again.')
      return
    } finally {
      setIsRestoring(false)
    }
    // Re-check that the dialog still refers to this same version before
    // clearing it: the dialog is guarded against dismissal while isRestoring
    // is true, but this identity check keeps success side effects (which
    // clear undo history) tied to the request that actually completed rather
    // than whatever version the dialog happens to show when the response
    // lands.
    if (pendingRestoreRef.current?.id !== v.id) return
    setPendingRestore(null)
    onRestored?.()
    // Refresh immediately after restore so the pending UI closes cleanly.
    await refresh()
  }, [pendingRestore, isRestoring, workspaceId, path, onRestored, refresh, fetchFn])

  const head = branchesState.head

  // EVERY lane, not only the one HEAD is on. The filter that used to stand
  // here made `mini-graph.ts`'s "rows on other branches use a ring dot" rule
  // unreachable — each row it drew was active by construction — and meant the
  // only way to see another variation's history was to switch onto it first.
  const visibleVersions = versions
  const miniGraphRows = buildMiniGraph({
    head,
    branches: branchesState.branches,
    versions: visibleVersions.map((v) => ({
      id: v.id,
      branchName: v.branchName ?? 'main',
      createdAt: v.createdAt,
    })),
  })
  const miniGraphById = new Map(miniGraphRows.map((r) => [r.versionId, r]))

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          <History className="size-3.5" />
          Version history
        </div>
        {/* Save actions live in the header now, so this panel stays focused on history. */}
      </div>

      <ScrollArea className="min-h-0 flex-1 -mx-1">
        <div className="flex flex-col gap-1.5 px-1">
          {branchesLoading || (loading && visibleVersions.length === 0) ? (
            // Until /branches resolves, `head` is the hook's 'main' default —
            // rendering rows filtered by it would offer the wrong branch's
            // versions as restore targets during the fetch race.
            <SquiggleLoader label="Loading…" className="py-4 text-xs" />
          ) : visibleVersions.length === 0 ? (
            <div className="text-xs text-muted-foreground py-4 text-center">
              {/* The document's history, not one lane's: the list is no longer
                  filtered, so an empty one means there is nothing anywhere. */}
              No versions yet.
              <br />
              Edit this canvas to trigger auto-save (~30s), or press ⌘/Ctrl+S.
            </div>
          ) : (
            visibleVersions.map((v) => {
              const row = miniGraphById.get(v.id)
              const operator = getOperatorAffordance(v.operator)
              return (
                <div key={v.id} className="flex items-stretch gap-1.5">
                  {/* Mini-graph lane. */}
                  {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative graph, aria-hidden removes it from the accessibility tree */}
                  <svg className="shrink-0" width={24} height={36} viewBox="0 0 24 36" aria-hidden>
                    {row?.connectorBefore ? (
                      <line
                        x1={12}
                        y1={0}
                        x2={12}
                        y2={14}
                        stroke={row.dotColor}
                        strokeWidth={1.5}
                        strokeOpacity={0.6}
                      />
                    ) : null}
                    {/* Solid on the lane HEAD is on, a ring on the others —
                        mini-graph's own rule, reachable now that the rows are
                        no longer pre-filtered to HEAD. */}
                    <circle
                      cx={12}
                      cy={18}
                      r={4}
                      fill={row?.active === false ? 'none' : (row?.dotColor ?? '#94a3b8')}
                      stroke={row?.dotColor ?? '#94a3b8'}
                      strokeWidth={row?.active === false ? 2 : 0}
                    />
                    <line
                      x1={12}
                      y1={22}
                      x2={12}
                      y2={36}
                      stroke={row?.dotColor ?? '#94a3b8'}
                      strokeWidth={1.5}
                      strokeOpacity={0.6}
                    />
                  </svg>
                  {/* Restore is offered on HEAD's lane only. Showing another
                      variation's history is not the same as offering to
                      restore from it: what restoring one variation's version
                      into another MEANS is undecided, and an affordance that
                      acts on an undecided semantic is worse than none. A row
                      on another lane is context, so it is not a control. */}
                  <RowShell
                    interactive={row?.active !== false}
                    onActivate={() => {
                      setRestoreError(null)
                      setPendingRestore(v)
                    }}
                  >
                    {v.hasThumbnail && (
                      <div className="mx-3 mb-1 border rounded overflow-hidden bg-muted/30">
                        <VersionThumbnail
                          workspaceId={workspaceId}
                          path={path}
                          versionId={v.id}
                          hasThumbnail={v.hasThumbnail}
                        />
                      </div>
                    )}
                    <CardContent className="px-3 flex items-center justify-between gap-2">
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-medium truncate">{versionTitle(v)}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {operator.icon} {operator.label}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {formatRelative(v.createdAt)} · {v.elementCount} els
                          {row?.branchOut ? (
                            <>
                              {' · '}
                              <span className="text-primary">
                                variation → {displayBranchName(row.branchOut)}
                              </span>
                            </>
                          ) : null}
                        </span>
                      </div>
                      {!v.auto && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium shrink-0">
                          manual
                        </span>
                      )}
                    </CardContent>
                  </RowShell>
                </div>
              )
            })
          )}
        </div>
      </ScrollArea>

      <AlertDialog
        open={!!pendingRestore}
        onOpenChange={(open) => {
          // A restore POST is in flight for the currently pending version;
          // dismissing here (Escape, overlay click, Cancel) would let the
          // user reopen the same or a different row and fire a second
          // /restore before the first resolves. Keep the dialog pinned to
          // the in-flight request until it settles.
          if (!open && isRestoring) return
          if (!open) {
            setPendingRestore(null)
            setRestoreError(null)
            setIsRestoring(false)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this version?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRestore && (
                <>
                  Restoring <strong>{versionTitle(pendingRestore)}</strong> (
                  {formatRelative(pendingRestore.createdAt)}, {pendingRestore.elementCount}{' '}
                  elements) will merge that state into the current canvas and broadcast the change
                  to every connected tab. Per-peer Ctrl+Z history is cleared.
                </>
              )}
              {restoreError && <span className="mt-2 block text-destructive">{restoreError}</span>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRestoring}>Cancel</AlertDialogCancel>
            {/* AlertDialogAction closes the dialog by default on click; prevent that so a
                failed restore keeps the dialog open with the error instead of discarding it. */}
            <AlertDialogAction
              disabled={isRestoring}
              onClick={(e) => {
                e.preventDefault()
                void confirmRestore()
              }}
            >
              {isRestoring ? 'Restoring…' : 'Restore'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
