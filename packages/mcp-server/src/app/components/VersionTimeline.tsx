import React, { useCallback, useEffect, useState } from 'react'
import { History } from 'lucide-react'
import { CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
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
import {
  type OperatorInfo,
  type VersionEntry,
  listVersionsResponseSchema,
} from '../../shared/api-contracts/canvas.js'
import { apiFetch } from '../lib/api-client.js'
import { useBranches } from '../hooks/useBranches.js'
import { buildMiniGraph } from '../lib/mini-graph.js'

interface Props {
  workspaceId: string
  slug: string
  // Called after restore succeeds so the browser-side LoroUndoManager can be cleared.
  onRestored?: () => void
}

// Render an ISO string as a short relative timestamp.
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return iso
  const diffSec = Math.floor((Date.now() - then) / 1000)
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  const d = new Date(then)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
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
export default function VersionTimeline({
  workspaceId,
  slug,
  onRestored,
}: Props) {
  const [versions, setVersions] = useState<VersionEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<VersionEntry | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch(
        `/api/workspaces/${workspaceId}/canvases/${encodeURIComponent(slug)}/versions`,
      )
      if (res.ok) {
        const parsed = listVersionsResponseSchema.safeParse(await res.json())
        if (parsed.success) setVersions(parsed.data.versions)
        else setVersions([])
      }
    } finally {
      setLoading(false)
    }
  }, [workspaceId, slug])

  // Reload whenever the canvas changes.
  useEffect(() => {
    refresh()
  }, [refresh])

  // Poll every 15 seconds for new auto-versions.
  useEffect(() => {
    const h = setInterval(() => {
      refresh()
    }, 15_000)
    return () => clearInterval(h)
  }, [refresh])

  const confirmRestore = useCallback(async () => {
    if (!pendingRestore) return
    const v = pendingRestore
    setPendingRestore(null)
    await apiFetch(
      `/api/workspaces/${workspaceId}/canvases/${encodeURIComponent(slug)}/versions/${v.id}/restore`,
      { method: 'POST' },
    )
    onRestored?.()
    // Refresh immediately after restore so the pending UI closes cleanly.
    await refresh()
  }, [pendingRestore, workspaceId, slug, onRestored, refresh])

  // Keep branch state here for head filtering and the mini-graph.
  // Legacy versions without branchName are treated as main.
  const { state: branchesState } = useBranches(workspaceId, slug)
  const head = branchesState.head

  const visibleVersions = versions.filter(
    (v) => (v.branchName ?? 'main') === head,
  )
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
          {loading && visibleVersions.length === 0 ? (
            <div className="text-xs text-muted-foreground py-4 text-center">Loading…</div>
          ) : visibleVersions.length === 0 ? (
            <div className="text-xs text-muted-foreground py-4 text-center">
              No versions on «{head}» yet.
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
                  <svg
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
                    <circle
                      cx={12}
                      cy={18}
                      r={4}
                      fill={row?.active ? row.dotColor : '#fff'}
                      stroke={row?.dotColor ?? '#94a3b8'}
                      strokeWidth={row?.active ? 0 : 1.5}
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
                  <button
                    type="button"
                    className="bg-card text-card-foreground flex flex-1 min-w-0 cursor-pointer flex-col gap-6 overflow-hidden rounded-xl border py-2 text-left shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    onClick={() => setPendingRestore(v)}
                  >
                    {v.hasThumbnail && (
                      <div className="mx-3 mb-1 border rounded overflow-hidden bg-muted/30">
                        <img
                          src={`/api/workspaces/${workspaceId}/canvases/${encodeURIComponent(slug)}/versions/${v.id}/thumbnail`}
                          alt=""
                          className="w-full h-20 object-contain"
                          loading="lazy"
                        />
                      </div>
                    )}
                    <CardContent className="px-3 flex items-center justify-between gap-2">
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-medium truncate">
                          {v.label || (v.auto ? 'Auto-save' : 'Manual')}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {operator.icon} {operator.label}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {formatRelative(v.createdAt)} · {v.elementCount} els
                          {row?.branchOut ? (
                            <>
                              {' · '}
                              <span className="text-primary">
                                branched → {row.branchOut}
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
                  </button>
                </div>
              )
            })
          )}
        </div>
      </ScrollArea>

      <AlertDialog open={!!pendingRestore} onOpenChange={(open) => !open && setPendingRestore(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this version?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRestore && (
                <>
                  Restoring <strong>{pendingRestore.label || (pendingRestore.auto ? 'Auto-save' : 'Manual')}</strong>{' '}
                  ({formatRelative(pendingRestore.createdAt)}, {pendingRestore.elementCount} elements) will merge
                  that state into the current canvas and broadcast the change to every connected tab. Per-peer
                  Ctrl+Z history is cleared.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRestore}>Restore</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
