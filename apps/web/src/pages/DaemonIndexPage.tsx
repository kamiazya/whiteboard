import { workspaceNamesSchema } from '@kamiazya/whiteboard-mcp/api-contracts'
import type { z } from 'zod'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CanvasThumb } from '../components/CanvasThumb.js'
import { StorageReportCard } from '../components/StorageReportCard.js'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import {
  createCanvas,
  createDaemonFetch,
  listCanvases,
  listWorkspaces,
} from '../lib/daemon-api-client.js'
import type { WhiteboardCapabilities } from '../lib/provider.js'

// A gallery for a connected daemon, scoped to ONE workspace at a time — the
// workspace selector picks which workspace's canvases populate the grid.
// Modeled on packages/mcp-server/src/app/pages/IndexPage.tsx's
// filter/sort/pin logic, but single-workspace rather than the all-workspace
// flat list that IndexPage renders (see the design note for why).

export interface DaemonIndexPageProps {
  daemonBaseUrl: string
  token?: string
  capabilities?: WhiteboardCapabilities
  // A workspace-level pairing link (#wb= with workspaceId but no slug) names
  // a specific workspace to land on; falls back to the daemon's first-listed
  // workspace when absent, or when the named workspace isn't in the list.
  initialWorkspaceId?: string
  onOpenCanvas: (workspaceId: string, slug: string) => void
}

interface CanvasRow {
  slug: string
  displayName: string
  updatedAt: string
  pinned: boolean
  pinOrder: number
}

// GET /api/workspaces/:id/names is not yet in daemon-api-client.ts (that
// module only exports the canvas-listing/creation trio). Kept local to this
// page rather than duplicated as a hand-written interface: hydrated through
// workspaceNamesSchema so pinned-order and display-name derivation can never
// drift from the wire contract.
async function fetchWorkspaceNames(
  fetchFn: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
): Promise<z.infer<typeof workspaceNamesSchema> | null> {
  try {
    const res = await fetchFn(
      `${daemonBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/names`,
    )
    if (!res.ok) return null
    const parsed = workspaceNamesSchema.safeParse(await res.json())
    if (!parsed.success) return null
    return parsed.data
  } catch {
    return null
  }
}

function filterRows(rows: CanvasRow[], search: string): CanvasRow[] {
  const needle = search.trim().toLowerCase()
  if (!needle) return rows
  return rows.filter(
    (r) => r.displayName.toLowerCase().includes(needle) || r.slug.toLowerCase().includes(needle),
  )
}

function sortRows(rows: CanvasRow[]): CanvasRow[] {
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.pinned && b.pinned) return a.pinOrder - b.pinOrder
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
    return 0
  })
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  // Clock drift between client and daemon can make (now - t) negative;
  // clamp so the label never reads "-5s ago".
  const diff = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

type TabKey = 'canvases' | 'storage'

export function DaemonIndexPage({
  daemonBaseUrl,
  token,
  initialWorkspaceId,
  onOpenCanvas,
}: DaemonIndexPageProps) {
  const daemonFetch = useMemo(() => createDaemonFetch(daemonBaseUrl, token), [daemonBaseUrl, token])

  const [tab, setTab] = useState<TabKey>('canvases')
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null)
  const [rows, setRows] = useState<CanvasRow[]>([])
  const [search, setSearch] = useState('')
  const [newCanvasSlug, setNewCanvasSlug] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listWorkspaces(daemonFetch, daemonBaseUrl)
      .then((res) => {
        if (cancelled) return
        const ids = res.workspaces.map((w) => w.workspaceId)
        setWorkspaces(ids)
        const targeted =
          initialWorkspaceId && ids.includes(initialWorkspaceId) ? initialWorkspaceId : undefined
        setSelectedWorkspace((current) => current ?? targeted ?? ids[0] ?? null)
      })
      .catch(() => {
        if (!cancelled) setLoadError('Failed to load workspaces.')
      })
    return () => {
      cancelled = true
    }
    // initialWorkspaceId is fixed for the page's lifetime (set once from the
    // pairing payload App.tsx resolved at mount) — it deliberately isn't a
    // dependency so this effect stays load-once, matching daemonBaseUrl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemonBaseUrl])

  const loadWorkspace = useCallback(
    async (workspaceId: string, isStale: () => boolean) => {
      setLoadError(null)
      try {
        const [canvasesRes, names] = await Promise.all([
          listCanvases(daemonFetch, daemonBaseUrl, workspaceId),
          fetchWorkspaceNames(daemonFetch, daemonBaseUrl, workspaceId),
        ])
        if (isStale()) return
        const pinIndex = new Map((names?.pinned ?? []).map((slug, i) => [slug, i]))
        const nextRows: CanvasRow[] = canvasesRes.canvases.map((c) => {
          const pinOrder = pinIndex.get(c.slug)
          return {
            slug: c.slug,
            displayName: names?.canvases?.[c.slug] ?? c.slug,
            updatedAt: c.updatedAt,
            pinned: pinOrder !== undefined,
            pinOrder: pinOrder ?? Number.POSITIVE_INFINITY,
          }
        })
        setRows(sortRows(nextRows))
      } catch {
        if (isStale()) return
        setRows([])
        setLoadError('Failed to load canvases for this workspace.')
      }
    },
    [daemonFetch, daemonBaseUrl],
  )

  useEffect(() => {
    if (!selectedWorkspace) return
    let cancelled = false
    // Clear synchronously BEFORE the async load: leaving the previous
    // workspace's rows visible during the switch lets a click pair the new
    // workspace id with an old workspace's slug — a mismatched identity.
    setRows([])
    setLoadError(null)
    void loadWorkspace(selectedWorkspace, () => cancelled)
    return () => {
      cancelled = true
    }
  }, [selectedWorkspace, loadWorkspace])

  const visible = useMemo(() => filterRows(rows, search), [rows, search])

  const handleCreate = useCallback(async () => {
    if (!selectedWorkspace || !newCanvasSlug.trim()) return
    setCreateError(null)
    try {
      const created = await createCanvas(
        daemonFetch,
        daemonBaseUrl,
        selectedWorkspace,
        newCanvasSlug.trim(),
      )
      setNewCanvasSlug('')
      onOpenCanvas(selectedWorkspace, created.slug)
    } catch (err) {
      // daemon-api-client errors are already sanitized (Problem Details
      // title or a generic status message) — safe to surface directly.
      setCreateError(err instanceof Error ? err.message : 'Failed to create canvas.')
    }
  }, [daemonFetch, daemonBaseUrl, selectedWorkspace, newCanvasSlug, onOpenCanvas])

  return (
    <DaemonApiContext.Provider value={daemonFetch}>
      <div className="flex h-dvh flex-col overflow-y-auto p-4">
        <h1 className="sr-only">Canvases</h1>
        <div className="mb-4 flex flex-wrap items-center gap-2 border-b pb-2">
          <div
            role="tablist"
            aria-label="Daemon index tabs"
            className="flex items-center gap-1 rounded-md border p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'canvases'}
              onClick={() => setTab('canvases')}
              className="rounded px-3 py-1 text-sm font-medium data-[selected=true]:bg-accent"
              data-selected={tab === 'canvases'}
            >
              Canvases
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'storage'}
              onClick={() => setTab('storage')}
              className="rounded px-3 py-1 text-sm font-medium data-[selected=true]:bg-accent"
              data-selected={tab === 'storage'}
            >
              Storage
            </button>
          </div>
          {tab === 'canvases' && (
            <>
              {workspaces.length > 0 && (
                <select
                  aria-label="Workspace"
                  value={selectedWorkspace ?? ''}
                  onChange={(event) => setSelectedWorkspace(event.target.value)}
                  className="rounded-md border bg-background px-2 py-1 text-sm"
                >
                  {workspaces.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              )}
              <input
                aria-label="Search canvases"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search…"
                className="rounded-md border bg-background px-2 py-1 text-sm"
              />
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void handleCreate()
                }}
              >
                <input
                  aria-label="New canvas name"
                  value={newCanvasSlug}
                  onChange={(event) => setNewCanvasSlug(event.target.value)}
                  className="rounded-md border bg-background px-2 py-1 text-sm"
                />
                <button
                  type="submit"
                  className="rounded-md border px-3 py-1 text-sm font-medium hover:bg-accent"
                >
                  Create canvas
                </button>
              </form>
            </>
          )}
        </div>

        {createError && (
          <div role="alert" className="mb-2 text-sm text-destructive">
            {createError}
          </div>
        )}

        {tab === 'storage' ? (
          <StorageReportCard />
        ) : loadError ? (
          <div role="alert" className="text-sm text-destructive">
            {loadError}
          </div>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No canvases match.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {visible.map((row) => {
              const hasDisplayName = row.displayName !== row.slug
              return (
                <button
                  key={row.slug}
                  type="button"
                  data-testid="daemon-index-canvas-card"
                  onClick={() => selectedWorkspace && onOpenCanvas(selectedWorkspace, row.slug)}
                  className="flex flex-col gap-2 rounded-lg border p-2 text-left hover:bg-accent"
                >
                  <CanvasThumb workspaceId={selectedWorkspace ?? ''} slug={row.slug} size="card" />
                  <div className="min-w-0">
                    {hasDisplayName && (
                      <div className="truncate text-sm font-medium">{row.displayName}</div>
                    )}
                    <div
                      data-testid="canvas-slug"
                      className={
                        hasDisplayName
                          ? 'truncate text-xs text-muted-foreground'
                          : 'truncate text-sm font-medium'
                      }
                    >
                      {row.slug}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatRelative(row.updatedAt)}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </DaemonApiContext.Provider>
  )
}
