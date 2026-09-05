import {
  type BranchMeta,
  documentsApiUrl,
  listVersionsResponseSchema,
  type MergeRequest,
  type MergeResponse,
  type VersionEntry,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import {
  AlertTriangle,
  ArrowDown,
  CheckCircle2,
  FileText,
  GitMerge,
  Info,
  Loader2,
} from 'lucide-react'
import { type JSX, useEffect, useMemo, useState } from 'react'
import { useDaemonApi } from '../contexts/DaemonApiContext.js'
import { safeErrorCopy } from '../lib/error-copy.js'
import { dispatchMergeCommitted } from '../lib/merge-committed-event.js'
import { cn, displayBranchName } from '../lib/utils.js'
import { Button } from './ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js'
import { VersionThumbnail } from './VersionThumbnail.js'

// Note: this originally tried to embed a read-only <Excalidraw> preview, but Excalidraw does not
// recommend multi-instance usage and it destabilized the main canvas scene state.
// The dialog now uses the latest source-branch thumbnail instead, while keeping
// MergeResponse.previewElements available for a future static renderer.

// Layout:
// - Top row: target and source comparison cards
// - Bottom row: a larger merged preview
// - Thumbnail fallback: if previewElements are unavailable, show the latest source thumbnail

export interface MergeDialogProps {
  open: boolean
  source: BranchMeta | null
  target: BranchMeta | null
  onClose: () => void
  runMerge: (source: string, args: MergeRequest) => Promise<MergeResponse>
  workspaceId?: string
  path?: string
}

interface BadgeView {
  key: string
  label: string
  tone: 'danger' | 'warning' | 'info'
  title: string
}

/**
 * The most recent thumbnail-bearing version on a branch, or null.
 *
 * Single pass with a strictly-greater comparison, rather than filter+sort+[0]
 * (an O(n log n) sort to read one extreme): a strictly-greater `createdAt`
 * only replaces the running pick on a genuine improvement, so the FIRST
 * array entry wins a tie — the same result `.sort((a, b) =>
 * b.createdAt.localeCompare(a.createdAt))[0]` gave, since `Array.sort` is
 * stable and a tie there keeps original order too.
 */
export function latestThumbnailVersion(
  versions: readonly VersionEntry[],
  branchName: string,
): VersionEntry | null {
  let latest: VersionEntry | null = null
  for (const v of versions) {
    if (!v.hasThumbnail || v.branchName !== branchName) continue
    if (latest === null || v.createdAt.localeCompare(latest.createdAt) > 0) latest = v
  }
  return latest
}

function badgeLabel(badge: Record<string, unknown>): BadgeView {
  const type = typeof badge.type === 'string' ? badge.type : 'unknown'
  const elementId = typeof badge.elementId === 'string' ? badge.elementId : '?'
  if (type === 'resurrected') {
    return {
      key: `${type}:${elementId}`,
      label: `Deleted element restored: ${elementId}`,
      tone: 'warning',
      title:
        'This element was deleted on the target canvas but edited on the incoming branch, so it will be restored.',
    }
  }
  if (type === 'orphan_ref') {
    const missing = typeof badge.missingRef === 'string' ? badge.missingRef : '?'
    return {
      key: `${type}:${elementId}:${missing}`,
      label: `Missing reference: ${elementId} -> ${missing}`,
      tone: 'danger',
      title:
        'A referenced target such as an arrow binding was deleted, so this item will be orphaned after merge.',
    }
  }
  if (type === 'field_merge') {
    const fields = Array.isArray(badge.fields) ? (badge.fields as string[]).join(', ') : ''
    return {
      key: `${type}:${elementId}`,
      label: `Edited on both sides: ${elementId} (${fields})`,
      tone: 'info',
      title:
        'The same element was edited on both branches, so the last-write-wins result will be kept.',
    }
  }
  return {
    key: `${type}:${elementId}`,
    label: `${type}: ${elementId}`,
    tone: 'info',
    title: 'Unclassified badge',
  }
}

const TONE_STYLE: Record<
  BadgeView['tone'],
  { fg: string; bg: string; border: string; icon: typeof AlertTriangle; summaryLabel: string }
> = {
  danger: {
    fg: '#dc2626',
    bg: '#fee2e2',
    border: '#fecaca',
    icon: AlertTriangle,
    summaryLabel: 'critical',
  },
  warning: {
    fg: '#d97706',
    bg: '#fef3c7',
    border: '#fde68a',
    icon: AlertTriangle,
    summaryLabel: 'warning',
  },
  info: { fg: '#1971c2', bg: '#dbeafe', border: '#bfdbfe', icon: Info, summaryLabel: 'info' },
}

interface CompareCardProps {
  kind: 'target' | 'source'
  branch: BranchMeta | null
  count: number | undefined
  delta?: number
  workspaceId?: string
  path?: string
  thumbVersionId: string | null
  loading: boolean
}

function CompareCard({
  kind,
  branch,
  count,
  delta,
  workspaceId,
  path,
  thumbVersionId,
  loading,
}: CompareCardProps): JSX.Element {
  const accent = branch?.color ?? '#64748b'
  const title = kind === 'target' ? 'Current canvas (target)' : 'Incoming changes'
  const deltaVisible = typeof delta === 'number' && delta !== 0 ? delta : null
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border-2 bg-card p-3"
      style={{ borderColor: accent }}
      data-testid={`merge-branch-card-${kind}`}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block size-2 shrink-0 rounded-full"
          style={{ background: accent }}
        />
        <span
          className="text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: accent }}
        >
          {title}
        </span>
      </div>
      <div className="relative aspect-video overflow-hidden rounded border bg-muted/30">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : thumbVersionId && workspaceId && path ? (
          <VersionThumbnail
            workspaceId={workspaceId}
            path={path}
            versionId={thumbVersionId}
            hasThumbnail
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <FileText className="size-5 opacity-40" />
            <span className="text-[10px]">No preview yet</span>
          </div>
        )}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium" title={branch?.name ?? ''}>
          {branch?.name ?? '—'}
        </span>
        <div className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
          <span>{count ?? '—'} elements</span>
          {deltaVisible !== null && (
            <span
              className={cn(
                'rounded-full px-1.5 font-medium tabular-nums',
                deltaVisible > 0
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : 'bg-amber-500/10 text-amber-600',
              )}
            >
              {deltaVisible > 0 ? '+' : ''}
              {deltaVisible}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export function MergeDialog({
  open,
  source,
  target,
  onClose,
  runMerge,
  workspaceId,
  path,
}: MergeDialogProps): JSX.Element {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<MergeResponse | null>(null)
  const [committing, setCommitting] = useState(false)
  const [thumbs, setThumbs] = useState<{ target: string | null; source: string | null }>({
    target: null,
    source: null,
  })
  const [thumbsLoading, setThumbsLoading] = useState(false)
  const fetchFn = useDaemonApi()

  // Dry-run preview.
  useEffect(() => {
    if (!open || !source || !target) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setPreview(null)
    runMerge(source.name, { into: target.name, dryRun: true })
      .then((res) => {
        if (!cancelled) setPreview(res)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(safeErrorCopy(err, 'Preview failed.'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, source, target, runMerge])

  // Thumbnail fallback — resolves the latest thumbnail-bearing version id per
  // branch. Runs in both same-origin and daemon mode: VersionThumbnail (used
  // by CompareCard below) handles the authorized fetch + objectURL in daemon
  // mode, so this effect only needs the version id, never a raw <img> URL.
  useEffect(() => {
    if (!open || !source || !target || !workspaceId || !path) {
      setThumbs({ target: null, source: null })
      return
    }
    let cancelled = false
    setThumbsLoading(true)
    ;(async () => {
      try {
        const res = await fetchFn(documentsApiUrl(workspaceId, path, 'versions'))
        if (!res.ok) {
          if (!cancelled) setThumbs({ target: null, source: null })
          return
        }
        const parsed = listVersionsResponseSchema.safeParse(await res.json())
        if (cancelled) return
        if (!parsed.success) {
          setThumbs({ target: null, source: null })
          return
        }
        const tgt = latestThumbnailVersion(parsed.data.versions, target.name)
        const src = latestThumbnailVersion(parsed.data.versions, source.name)
        setThumbs({
          target: tgt?.id ?? null,
          source: src?.id ?? null,
        })
      } catch {
        // Fall back to placeholders if thumbnail loading fails, so a stale pair from a
        // previous source/target selection is never shown as the current preview.
        if (!cancelled) setThumbs({ target: null, source: null })
      } finally {
        if (!cancelled) setThumbsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, source, target, workspaceId, path, fetchFn])

  const handleMerge = async () => {
    if (!source || !target) return
    setCommitting(true)
    setError(null)
    try {
      const res = await runMerge(source.name, { into: target.name, dryRun: false })
      setPreview(res)
      // Broadcast merge results for the toast and highlight layers when session/path are available.
      if (typeof window !== 'undefined' && workspaceId && path) {
        dispatchMergeCommitted({
          workspaceId,
          path,
          sourceName: source.name,
          targetName: target.name,
          newCount: res.newElementIds?.length ?? 0,
          changedCount: res.changedElementIds?.length ?? 0,
          conflictCount: res.conflictElementIds?.length ?? 0,
          preMergeVersionId: res.preMergeVersionId,
          newElementIds: res.newElementIds ?? [],
          conflictElementIds: res.conflictElementIds ?? [],
          switchedHead: res.switchedHead,
          deletedSource: res.deletedSource,
        })
      }
      onClose()
    } catch (err) {
      setError(safeErrorCopy(err, 'Combine failed.'))
    } finally {
      setCommitting(false)
    }
  }

  const badges = preview?.badges ?? []
  const badgeViews = useMemo(() => badges.map(badgeLabel), [badges])
  const badgeByTone = useMemo(() => {
    return badgeViews.reduce(
      (acc, v) => {
        acc[v.tone] = (acc[v.tone] ?? 0) + 1
        return acc
      },
      {} as Record<BadgeView['tone'], number>,
    )
  }, [badgeViews])

  const targetCount = preview?.target?.elementCount
  const sourceCount = preview?.source?.elementCount
  const previewCount = preview?.preview?.elementCount ?? preview?.committed?.elementCount
  const sourceDelta =
    typeof sourceCount === 'number' && typeof targetCount === 'number'
      ? sourceCount - targetCount
      : undefined

  // Preview element count is still shown even though the inline Excalidraw preview was removed.
  const previewElementCount = preview?.previewElements?.length ?? previewCount ?? 0

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="grid max-h-[90dvh] max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="h-4 w-4" />
            <span>
              Combine{' '}
              <span style={{ color: source?.color ?? undefined }} className="font-semibold">
                «{source ? displayBranchName(source.name) : '?'}»
              </span>{' '}
              into{' '}
              <span style={{ color: target?.color ?? undefined }} className="font-semibold">
                «{target ? displayBranchName(target.name) : '?'}»
              </span>
            </span>
          </DialogTitle>
          <DialogDescription>
            Content conflicts are resolved automatically. Use the badges below to review changes
            that may need attention.
          </DialogDescription>
        </DialogHeader>

        {/* Scrollable body: the confirm footer below must stay reachable even when
            the preview panes and badge list grow taller than the viewport. */}
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto" data-slot="merge-dialog-body">
          {error ? (
            <div className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          ) : null}

          {/* Keep source on the left and target on the right to match the dialog title reading order. */}
          <div className="grid grid-cols-2 gap-3">
            <CompareCard
              kind="source"
              branch={source}
              count={sourceCount}
              delta={sourceDelta}
              workspaceId={workspaceId}
              path={path}
              thumbVersionId={thumbs.source}
              loading={thumbsLoading}
            />
            <CompareCard
              kind="target"
              branch={target}
              count={targetCount}
              workspaceId={workspaceId}
              path={path}
              thumbVersionId={thumbs.target}
              loading={thumbsLoading}
            />
          </div>

          {/* Arrow showing the flow into the merged preview below. */}
          <div className="flex items-center justify-center text-muted-foreground">
            <ArrowDown className="size-4" aria-hidden />
          </div>

          {/* Main merged preview. */}
          <div
            className="flex flex-col gap-2 rounded-lg border-2 bg-card p-3 ring-1 ring-emerald-500/20"
            style={{ borderColor: '#2f9e44' }}
            data-testid="merge-branch-card-preview"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block size-2 shrink-0 rounded-full bg-emerald-500"
                />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600">
                  Combined preview
                </span>
              </div>
              <div className="text-xs text-muted-foreground">{previewCount ?? '—'} elements</div>
            </div>
            <div className="relative h-[340px] overflow-hidden rounded border bg-muted/30">
              {loading ? (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Calculating preview…
                </div>
              ) : thumbs.source && workspaceId && path ? (
                // Show the latest source-branch thumbnail as a practical preview fallback.
                <VersionThumbnail
                  workspaceId={workspaceId}
                  path={path}
                  versionId={thumbs.source}
                  hasThumbnail
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
                  <FileText className="size-6 opacity-40" />
                  <div className="text-center text-xs">
                    <div>{previewElementCount > 0 ? 'No preview image yet' : 'No elements'}</div>
                    <div className="mt-1 text-[10px] opacity-80">
                      Open «{source ? displayBranchName(source.name) : '?'}» and save with ⌘S to
                      generate its preview
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Badges / conflict summary */}
          <div className="rounded-lg border bg-muted/30 p-3">
            {loading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Checking conflicts…
              </div>
            ) : error && badgeViews.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <AlertTriangle className="size-3.5" />
                Conflict status unavailable - see error above.
              </div>
            ) : badgeViews.length === 0 ? (
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="size-4 text-emerald-600" />
                <span>
                  <strong className="text-emerald-700">No conflicts</strong> - ready to combine
                  as-is
                </span>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-3 text-sm">
                  <AlertTriangle className="size-4 text-amber-600" />
                  <strong>{badgeViews.length} changes to review</strong>
                  <span className="text-xs text-muted-foreground">
                    {(['danger', 'warning', 'info'] as const)
                      .filter((t) => (badgeByTone[t] ?? 0) > 0)
                      .map((t) => `${badgeByTone[t]} ${TONE_STYLE[t].summaryLabel}`)
                      .join(' · ')}
                  </span>
                </div>
                <ul className="flex flex-wrap gap-1.5">
                  {badgeViews.map((view) => {
                    const tone = TONE_STYLE[view.tone]
                    const Icon = tone.icon
                    return (
                      <li
                        key={view.key}
                        title={view.title}
                        className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
                        style={{
                          borderColor: tone.border,
                          backgroundColor: tone.bg,
                          color: tone.fg,
                        }}
                      >
                        <Icon className="size-3" aria-hidden />
                        {view.label}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </div>

          {/* Make the post-merge side effects explicit before the user confirms. */}
          {source && target && source.name !== target.name && source.name !== 'main' && (
            <div
              className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-xs text-sky-900"
              data-testid="merge-side-effect-notice"
            >
              <strong>After combining:</strong> switch automatically to "
              <span className="font-semibold">{displayBranchName(target.name)}</span>" and delete "
              <span className="font-semibold">{displayBranchName(source.name)}</span>
              ".
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={committing}>
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="merge-confirm-button"
            onClick={handleMerge}
            disabled={loading || committing || !preview || !source || !target}
          >
            {committing ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Combining…
              </>
            ) : (
              <>
                <GitMerge className="size-3.5" />
                Combine
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
