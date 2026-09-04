import type { OperatorInfo, VersionEntry } from '@kamiazya/whiteboard-mcp/api-contracts'
import { History } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDaemonApi } from '@/contexts/DaemonApiContext'
import { useVersionsBackend } from '@/contexts/VersionsBackendContext'
import { useBranches } from '@/hooks/useBranches'
import { getAppLogger } from '@/lib/app-logger'
import { buildMiniGraph } from '@/lib/mini-graph'
import { displayBranchName } from '@/lib/utils'
import { type PastDocument, VersionsRequestError } from '@/lib/versions-backend'
import { SquiggleLoader } from './SquiggleLoader.js'
import { VersionThumbnail } from './VersionThumbnail.js'
import { formatRelative } from './workspace-files/format-relative.js'

const log = getAppLogger('VersionTimeline')

/**
 * A past state on screen, and the two things a person can do about it.
 *
 * Published by the panel and rendered by whoever owns the document's
 * chrome. Carries `isRestoring` and `error` because the chrome shows them:
 * the restore is in flight on the document, not in the history.
 */
export interface VersionPreviewSession {
  readonly past: PastDocument
  /** What the row calls it — a name if someone gave one, otherwise when. */
  readonly title: string
  readonly isRestoring: boolean
  readonly error: string | null
  /** Put the live document back. Refused while a restore is in flight. */
  readonly stop: () => void
  /** Apply this state to the document. */
  readonly restore: () => void
}

/**
 * What the keeper behind this history can do.
 *
 * A prop rather than a read of the provider's capability map, because these
 * are not the same question: that map says what the CONNECTION offers, and
 * this says what the history in front of you does. The two shapes below are
 * the only answers a keeper has, named so a mount states which keeper it is
 * instead of writing a literal that reads like a preference.
 */
export interface VersionTimelineCapabilities {
  readonly branches: boolean
  readonly autoVersions: boolean
}

/** The daemon's history: lanes, and a checkpoint after work settles. */
export const DAEMON_HISTORY_CAPABILITIES: VersionTimelineCapabilities = {
  branches: true,
  autoVersions: true,
}

/** The browser's history: one lane, and a point only when asked for. */
export const BROWSER_HISTORY_CAPABILITIES: VersionTimelineCapabilities = {
  branches: false,
  autoVersions: false,
}

interface Props {
  workspaceId: string
  path: string
  capabilities?: VersionTimelineCapabilities
  // Called after restore succeeds so the browser-side LoroUndoManager can be cleared.
  onRestored?: () => void
  /**
   * Publishes the whole LOOKING-AT session, or null when there is none.
   *
   * Still only a publication: the panel owns every version act — loading,
   * restoring, refreshing — and hands out the two callbacks rather than the
   * ability to do either itself, so there is exactly one place that knows
   * how a version behaves. What moved out is where the session is DRAWN,
   * because the thing that changed is the document, and the controls belong
   * on it rather than in a panel that a narrow screen puts at the far edge.
   */
  onPreview?: (session: VersionPreviewSession | null) => void
  // Bumped by the caller (e.g. after a manual save, or a WS
  // version_created broadcast) to force a refetch without waiting for the
  // 15s poll. Only a value CHANGE triggers a refetch, matching
  // HeaderBranchChip's refreshSignal contract.
  refreshSignal?: number
  // The panel header's action slot — the page's own save affordance. It
  // sits in the header because that is where the panel's own title is: an
  // action bar pinned under the list would have put the one control a
  // phone can reach below 480px of scrolling history.
  headerActions?: ReactNode
}

/**
 * This surface's two knobs on the shared formatter, bound once.
 *
 * Past a day a saved version's DATE is the interesting fact rather than its
 * age, and a corrupt `createdAt` echoes rather than rendering blank — the
 * two places a private clone of this had silently diverged. Bound here
 * because four call sites repeating the options object is the same
 * hand-kept duplication one level down.
 */
function versionTime(iso: string): string {
  return formatRelative(iso, { pastDay: 'absolute', invalid: 'echo' })
}

/**
 * A version's title, from the content side.
 *
 * The label if a person gave it one; otherwise WHEN. Every unlabelled
 * version used to be titled "Auto-save", which made three consecutive
 * checkpoints read as three identical rows and named the mechanism rather
 * than the thing. What tells them apart is the time, so the time is the
 * title.
 *
 * A label existing is also what says a person marked this deliberately —
 * which is why there is no "manual" badge any more, and no third vocabulary
 * saying it again.
 */
function versionTitle(version: Pick<VersionEntry, 'label' | 'createdAt'>): string {
  return version.label || versionTime(version.createdAt)
}

/**
 * Who took it, said once, and only when there is someone to name.
 *
 * An automatic checkpoint has no author — it answers `null` rather than
 * "System", which was the same fact the old "Auto-save" title had already
 * stated one line above.
 */
function versionAuthor(operator?: OperatorInfo): string | null {
  const named = operator?.displayName?.trim()
  if (named) return named
  if (operator?.kind === 'ai') return 'Agent'
  if (operator?.kind === 'human') return 'You'
  return null
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

export default function VersionTimeline({
  workspaceId,
  path,
  capabilities = DAEMON_HISTORY_CAPABILITIES,
  onRestored,
  onPreview,
  refreshSignal,
  headerActions,
}: Props) {
  const fetchFn = useDaemonApi()
  const versionsBackend = useVersionsBackend()
  const [versions, setVersions] = useState<VersionEntry[]>([])
  const [loading, setLoading] = useState(false)
  /** The last read failed, so what is on screen is older than it looks. */
  const [stale, setStale] = useState(false)
  /** The version currently being LOOKED at, before deciding to apply it. */
  const [previewing, setPreviewing] = useState<VersionEntry | null>(null)
  // The loaded state itself, kept rather than handed straight out: the
  // session is re-published whenever `isRestoring` or the error moves, and
  // re-loading the document to do that would refetch on every keystroke of
  // state.
  const [previewPast, setPreviewPast] = useState<PastDocument | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [isRestoring, setIsRestoring] = useState(false)
  // Mirrors `previewing`, refreshed on every render so an async handler's
  // async continuation can read the *current* pending version after an
  // await, instead of a value closed over before the request started.
  const previewingRef = useRef<VersionEntry | null>(previewing)
  previewingRef.current = previewing
  // Monotonically increasing sequence stamp. Each refresh() call captures the
  // value at dispatch time; a response only commits if no newer refresh has
  // started meanwhile. Without this, a slow /versions response for an older
  // workspaceId/path pair could overwrite the list after the canvas changed.
  const fetchSeqRef = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++fetchSeqRef.current
    setLoading(true)
    try {
      const next = await versionsBackend.list(workspaceId, path)
      if (seq !== fetchSeqRef.current) return
      setVersions(next)
      setStale(false)
    } catch (err) {
      if (seq !== fetchSeqRef.current) return
      // A failed read used to be logged and nothing else, so the panel kept
      // showing the rows it happened to have — with no way to tell them from
      // a current list. The rows stay (they are still the last true answer)
      // and stop claiming to be up to date.
      setStale(true)
      if (err instanceof VersionsRequestError) {
        log.error('versions request failed', { status: err.status, workspaceId, path })
      } else if (err instanceof Error && err.message.includes('schema validation')) {
        log.error('versions response failed schema validation', { workspaceId, path })
        setVersions([])
      } else {
        log.error('versions request threw', err)
      }
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false)
    }
  }, [workspaceId, path, versionsBackend])

  // Clear the previously loaded canvas's versions immediately on canvas
  // change so a stale row (with thumbnail URLs pointing at the old
  // workspaceId/path) never renders under the new canvas while the refetch
  // is in flight. Also drop any open preview — restoring a state the person
  // was looking at on the PREVIOUS document would apply that version id to
  // the one that arrived.
  // SCOPE RESET — see scoped-screen-state.test.ts
  useEffect(() => {
    setVersions([])
    setPreviewing(null)
    setPreviewPast(null)
    setRestoreError(null)
    setIsRestoring(false)
    onPreview?.(null)
  }, [workspaceId, path, onPreview])

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
  } = useBranches(workspaceId, path, fetchFn, { enabled: capabilities.branches })

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

  /**
   * Look at a version: load what it holds and hand it to the page to draw.
   *
   * This is what replaced a confirmation dialog. The dialog asked whether to
   * apply a state nobody could see; applying it and looking was the only way
   * to find out what was in it, and the way back was undo.
   */
  const openPreview = useCallback(
    async (v: VersionEntry) => {
      // Never while a restore is in flight, and not merely because two
      // states on screen would be confusing: `restorePreviewed` decides
      // whether to run its success effects by comparing the version it
      // asked for against whatever the panel is showing when the response
      // lands. Choosing another row in that window makes the comparison
      // fail for a restore that SUCCEEDED — the undo history keeps the
      // pre-restore document and the list never refreshes, while the
      // document itself has already moved.
      if (isRestoring) return
      setRestoreError(null)
      setPreviewing(v)
      try {
        const past = await versionsBackend.loadPast(workspaceId, path, v.id)
        // Still the version the person asked for? A slower load for an
        // earlier row must not draw itself over a later choice.
        if (previewingRef.current?.id !== v.id) return
        if (past === null) {
          setPreviewing(null)
          setRestoreError('That version could not be read.')
          return
        }
        setPreviewPast(past)
      } catch (err) {
        if (previewingRef.current?.id !== v.id) return
        log.error('version document request threw', err)
        setPreviewing(null)
        setRestoreError('That version could not be read.')
      }
    },
    [isRestoring, workspaceId, path, versionsBackend],
  )

  const closePreview = useCallback(() => {
    // Never while a restore is in flight. Stopping then would put the live
    // document back on screen while the past state is still landing on it,
    // and would unlock a second submission of the same restore.
    if (isRestoring) return
    setPreviewing(null)
    setPreviewPast(null)
    setRestoreError(null)
  }, [isRestoring])

  const restorePreviewed = useCallback(async () => {
    // Guard against a double activation firing a second restore before the
    // first response comes back.
    const v = previewingRef.current
    if (!v || isRestoring) return
    setRestoreError(null)
    setIsRestoring(true)
    // Success side effects (onRestored clears the browser-side undo manager)
    // run only once the keeper confirms: a failed request must not discard
    // undo history for a restore that did not happen.
    try {
      await versionsBackend.restore(workspaceId, path, v.id)
    } catch (err) {
      if (err instanceof VersionsRequestError) {
        log.error('restore request failed', { status: err.status, versionId: v.id })
      } else {
        log.error('restore request threw', err)
      }
      setRestoreError('Restore failed. Please try again.')
      return
    } finally {
      setIsRestoring(false)
    }
    // Tied to the request that completed rather than to whatever the panel
    // shows when the response lands.
    if (previewingRef.current?.id !== v.id) return
    setPreviewing(null)
    setPreviewPast(null)
    onRestored?.()
    await refresh()
  }, [isRestoring, workspaceId, path, onRestored, refresh, versionsBackend])

  // One place the session is published from, rather than a call beside every
  // state change: `isRestoring` and the error move without any of the open /
  // stop / restore paths running, and a chrome showing a stale "restoring…"
  // is exactly the state a person is watching.
  const onPreviewRef = useRef(onPreview)
  onPreviewRef.current = onPreview
  useEffect(() => {
    if (previewing === null || previewPast === null) {
      onPreviewRef.current?.(null)
      return
    }
    onPreviewRef.current?.({
      past: previewPast,
      title: versionTitle(previewing),
      isRestoring,
      error: restoreError,
      stop: closePreview,
      restore: () => {
        void restorePreviewed()
      },
    })
  }, [previewing, previewPast, isRestoring, restoreError, closePreview, restorePreviewed])

  const head = branchesState.head

  // EVERY lane, not only the one HEAD is on. The filter that used to stand
  // here made `mini-graph.ts`'s "rows on other branches use a ring dot" rule
  // unreachable — each row it drew was active by construction — and meant the
  // only way to see another variation's history was to switch onto it first.
  const visibleVersions = versions
  // Re-derived only off head/branches/versions — NOT off previewing,
  // isRestoring, restoreError, stale, or loading, all of which change far
  // more often and none of which buildMiniGraph (O(versions)) reads.
  const { miniGraphById, versionsById } = useMemo(() => {
    const rows = buildMiniGraph({
      head,
      branches: branchesState.branches,
      versions: visibleVersions.map((v) => ({
        id: v.id,
        branchName: v.branchName ?? 'main',
        createdAt: v.createdAt,
        ...(v.restoredFrom === undefined ? {} : { restoredFrom: v.restoredFrom }),
      })),
    })
    return {
      miniGraphById: new Map(rows.map((r) => [r.versionId, r])),
      versionsById: new Map(visibleVersions.map((v) => [v.id, v])),
    }
  }, [head, branchesState.branches, visibleVersions])

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          <History className="size-3.5" />
          Version history
        </div>
        {headerActions}
      </div>

      {/* Only the errors with no session to carry them — a version that
          could not be read. A failed RESTORE is shown on the document's
          chrome, beside the state it failed to change. */}
      {restoreError && previewing === null && (
        <div role="alert" className="px-1 text-[11px] text-destructive">
          {restoreError}
        </div>
      )}

      {stale && (
        <div data-testid="version-list-stale" className="text-[11px] text-muted-foreground px-1">
          Could not refresh — showing what was last read.
        </div>
      )}

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
              {/* No interval in the copy. A number here is a second place
                  the trigger's timing lives, and the one nothing updates —
                  it read "~30s" through the whole life of the five-minute
                  pause that replaced it. */}
              {capabilities.autoVersions
                ? 'A checkpoint is saved a little after you stop editing. Bookmark this point with the button above, or ⌘/Ctrl+S.'
                : 'Save one with the button above, or ⌘/Ctrl+S.'}
            </div>
          ) : (
            visibleVersions.map((v) => {
              const row = miniGraphById.get(v.id)
              const author = versionAuthor(v.operator)
              const restoredSource =
                row?.restoredFrom === undefined ? undefined : versionsById.get(row.restoredFrom)
              const restoredFromTitle =
                restoredSource === undefined ? null : versionTitle(restoredSource)
              return (
                <div key={v.id} data-testid="version-row" className="flex items-stretch gap-1.5">
                  {/* The lane column, only where lanes exist. A keeper with
                      one branch drew a straight line down the left of every
                      row and spent the width saying nothing. */}
                  {/* The lane is drawn for BRANCHES or for lineage. It used
                      to be branches-only, which left the browser keeper — one
                      lane, and restores like any other — with nowhere to draw
                      the arc a restore leaves. */}
                  {(capabilities.branches ||
                    row?.restoredFrom !== undefined ||
                    row?.isRestoreSource === true ||
                    row?.isRestoreArcThrough === true) && (
                    /* biome-ignore lint/a11y/noSvgWithoutTitle: decorative graph, aria-hidden removes it from the accessibility tree */
                    <svg
                      data-testid="version-lane"
                      className="shrink-0"
                      width={24}
                      height={36}
                      viewBox="0 0 24 36"
                      aria-hidden
                    >
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
                      {/* The arc a restore leaves, in the side channel at
                          x=20 so it never sits under the trunk. Painted a row
                          at a time — the top hook where the merge is, a
                          straight run through the rows between, the bottom
                          hook at the point that was restored — because one
                          row's 24x36 box cannot hold a span of several. */}
                      {row?.restoredFrom !== undefined && (
                        <path
                          d="M12 18 C20 18, 20 22, 20 36"
                          fill="none"
                          stroke={row.dotColor}
                          strokeWidth={1.5}
                          strokeDasharray="3 2"
                        />
                      )}
                      {row?.isRestoreArcThrough && (
                        <line
                          x1={20}
                          y1={0}
                          x2={20}
                          y2={36}
                          stroke={row.dotColor}
                          strokeWidth={1.5}
                          strokeDasharray="3 2"
                        />
                      )}
                      {row?.isRestoreSource && (
                        <path
                          d="M20 0 C20 14, 20 18, 12 18"
                          fill="none"
                          stroke={row.dotColor}
                          strokeWidth={1.5}
                          strokeDasharray="3 2"
                        />
                      )}
                    </svg>
                  )}
                  {/* Restore is offered on HEAD's lane only. Showing another
                      variation's history is not the same as offering to
                      restore from it: what restoring one variation's version
                      into another MEANS is undecided, and an affordance that
                      acts on an undecided semantic is worse than none. A row
                      on another lane is context, so it is not a control. */}
                  <RowShell
                    interactive={row?.active !== false}
                    onActivate={() => {
                      void openPreview(v)
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
                        {/* Only on the lanes HEAD is NOT on. A ring says "not
                            yours" and colour is not a name, so without this a
                            reader with two variations open has a row of
                            history and no way to tell whose. The lane you ARE
                            on is the frame the whole panel is read in —
                            repeating it on every row states the obvious and
                            makes the exceptions harder to see. */}
                        {row?.active === false && (
                          <span
                            data-testid="version-lane-name"
                            className="text-[11px] font-medium truncate"
                            style={{ color: row.dotColor }}
                          >
                            {displayBranchName(v.branchName ?? 'main')}
                          </span>
                        )}
                        <span className="text-[11px] text-muted-foreground">
                          {/* The time is only repeated here when the TITLE is
                              a label — otherwise it is already the title. */}
                          {[
                            v.label ? versionTime(v.createdAt) : null,
                            author,
                            `${v.elementCount} els`,
                          ]
                            .filter((part) => part !== null)
                            .join(' · ')}
                          {/* Why the arc exists. The SHAPE of the lineage is
                              derivable from the rows on their own; what no
                              amount of that can say is that these two points
                              met because somebody went back — the same reason
                              a merge commit carries a message. Named by what
                              the row it points at is CALLED, so the label and
                              the arc's far end read as the same thing. */}
                          {restoredFromTitle !== null ? (
                            <>
                              {' · '}
                              <span data-testid="version-restored-from" className="text-primary">
                                restored from {restoredFromTitle}
                              </span>
                            </>
                          ) : null}
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
                    </CardContent>
                  </RowShell>
                </div>
              )
            })
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
