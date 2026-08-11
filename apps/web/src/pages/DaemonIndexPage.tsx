import type { CanvasKind } from '@kamiazya/whiteboard-canvas-model'
import { workspaceNamesSchema } from '@kamiazya/whiteboard-mcp/api-contracts'
import { LayoutGrid, ListTree, Settings } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { z } from 'zod'
import { CanvasThumb } from '../components/CanvasThumb.js'
import { CanvasListView } from '../components/canvas-list/CanvasListView.js'
import { PairedOriginsCard } from '../components/PairedOriginsCard.js'
import { StorageReportCard } from '../components/StorageReportCard.js'
import { SettingsPanel } from '../components/settings/SettingsPanel.js'
import { WorkspaceFilesPanel } from '../components/workspace-files/WorkspaceFilesPanel.js'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { useThemeMode } from '../hooks/useThemeMode.js'
import {
  createCanvas,
  createDaemonFetch,
  getCanvasSnapshot,
  listCanvases,
  listWorkspaces,
  setCanvasName,
  updateCanvas,
} from '../lib/daemon-api-client.js'
import { deriveCopyName } from '../lib/derive-copy-name.js'
import { deriveCopySlug } from '../lib/derive-copy-slug.js'
import { deriveNewCanvasSlug } from '../lib/derive-new-canvas-slug.js'
import type { WhiteboardCapabilities } from '../lib/provider.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'

// A gallery for a connected daemon, scoped to ONE workspace at a time — the
// workspace selector picks which workspace's canvases populate the grid.
// Modeled on the original daemon-served UI's IndexPage filter/sort/pin logic
// (since retired), but single-workspace rather than the all-workspace flat
// list that IndexPage rendered (see the design note for why).

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
  kind: CanvasKind
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

function sortRows(rows: CanvasRow[]): CanvasRow[] {
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.pinned && b.pinned) return a.pinOrder - b.pinOrder
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
    return 0
  })
}

type ViewKey = 'grid' | 'tree'

export function DaemonIndexPage({
  daemonBaseUrl,
  token,
  initialWorkspaceId,
  onOpenCanvas,
}: DaemonIndexPageProps) {
  const daemonFetch = useMemo(() => createDaemonFetch(daemonBaseUrl, token), [daemonBaseUrl, token])

  const [view, setView] = useState<ViewKey>('grid')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { theme, setTheme } = useThemeMode()
  const [settingsStore] = useState(() => createUserSettingsStore())
  const [webMcpEnabled, setWebMcpEnabled] = useState(
    () => settingsStore.load().capabilities.webMcpEnabled !== false,
  )
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null)
  const [rows, setRows] = useState<CanvasRow[]>([])
  // False from the moment a workspace switch clears rows until its canvases
  // fetch settles — rows=[] alone cannot distinguish "still loading" from
  // "genuinely empty", and rendering an empty state during the gap reads as
  // data loss.
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [duplicateError, setDuplicateError] = useState<string | null>(null)
  // Which card's Duplicate action is currently in flight — disables just that
  // card's button (a second click during the async read-then-write must not
  // start a second copy) rather than a page-wide boolean.
  const [duplicatingSlug, setDuplicatingSlug] = useState<string | null>(null)
  // Disables both create controls while one is in flight, so a second press cannot send another
  // POST deriving the identical slug from the same rows. The `disabled` attribute is the whole
  // mechanism — an early `if (creating) return` inside the handler was also tried and removed: it
  // reads `creating` from the render closure, so it is stale in exactly the same-tick case it
  // would have to catch, and no test could distinguish its presence from its absence.
  const [creating, setCreating] = useState(false)

  // Always-current mirror of selectedWorkspace for handleDuplicate's async
  // completion check below: a plain ref write during render (not inside an
  // effect) is safe here because it never triggers a re-render itself, and
  // it must reflect the LATEST selection synchronously, including the very
  // render that changes it — an effect-synced ref would lag by one render.
  const selectedWorkspaceRef = useRef(selectedWorkspace)
  selectedWorkspaceRef.current = selectedWorkspace

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
            kind: c.kind,
            pinned: pinOrder !== undefined,
            pinOrder: pinOrder ?? Number.POSITIVE_INFINITY,
          }
        })
        setRows(sortRows(nextRows))
        setLoaded(true)
      } catch {
        if (isStale()) return
        setRows([])
        setLoaded(true)
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
    setLoaded(false)
    setLoadError(null)
    void loadWorkspace(selectedWorkspace, () => cancelled)
    return () => {
      cancelled = true
    }
  }, [selectedWorkspace, loadWorkspace])

  // Creation is immediate — no name is collected up front (ADR-0006 point
  // 3). A slug is derived from the loaded rows so it never collides with a
  // canvas already in the list; naming happens afterwards, in the opened
  // canvas's own top bar.
  const handleCreate = useCallback(
    async (kind: CanvasKind) => {
      if (!selectedWorkspace) return
      const workspaceAtStart = selectedWorkspace
      setCreating(true)
      setCreateError(null)
      try {
        const slug = deriveNewCanvasSlug(rows.map((r) => r.slug))
        const created = await createCanvas(daemonFetch, daemonBaseUrl, workspaceAtStart, slug, kind)
        onOpenCanvas(workspaceAtStart, created.slug)
      } catch (err) {
        // daemon-api-client errors are already sanitized (Problem Details
        // title or a generic status message) — safe to surface directly.
        setCreateError(err instanceof Error ? err.message : 'Failed to create canvas.')
        // The slug is derived from `rows`, so a failure caused by a name this list has not seen
        // (another tab, a lost race) would otherwise re-derive the SAME slug on every retry and
        // collide forever. Re-read the list so the next derive skips what is actually taken.
        const isStale = () => selectedWorkspaceRef.current !== workspaceAtStart
        if (!isStale()) await loadWorkspace(workspaceAtStart, isStale)
      } finally {
        setCreating(false)
      }
    },
    [daemonFetch, daemonBaseUrl, selectedWorkspace, rows, onOpenCanvas, loadWorkspace],
  )

  // Client-side copy through EXISTING daemon HTTP endpoints only (read
  // snapshot -> create canvas -> write snapshot -> rename), matching the
  // browser-local controller's read-then-write duplicate flow rather than
  // requiring a dedicated server-side "duplicate" endpoint.
  const handleDuplicate = useCallback(
    async (sourceSlug: string) => {
      if (duplicatingSlug !== null) return
      const workspaceAtStart = selectedWorkspace
      if (!workspaceAtStart) return
      setDuplicatingSlug(sourceSlug)
      setDuplicateError(null)
      const sourceRow = rows.find((r) => r.slug === sourceSlug)
      // The whole operation targets workspaceAtStart, not whatever the user
      // has switched the selector to by the time each await resolves — a
      // duplicate started in one workspace must finish in that SAME
      // workspace even if the user has since switched away from it. Applying
      // its completion (the rows refresh) to the page is gated separately,
      // below, on whether that workspace is still the one being viewed.
      try {
        const snapshot = await getCanvasSnapshot(
          daemonFetch,
          daemonBaseUrl,
          workspaceAtStart,
          sourceSlug,
        )
        const existingSlugs = new Set(rows.map((r) => r.slug))
        const newSlug = deriveCopySlug(sourceSlug, existingSlugs)
        const created = await createCanvas(daemonFetch, daemonBaseUrl, workspaceAtStart, newSlug)
        await updateCanvas(daemonFetch, daemonBaseUrl, workspaceAtStart, created.slug, snapshot)
        const existingNames = new Set(rows.map((r) => r.displayName))
        const newName = deriveCopyName(sourceRow?.displayName ?? sourceSlug, existingNames)
        await setCanvasName(daemonFetch, daemonBaseUrl, workspaceAtStart, created.slug, newName)
        const isStale = () => selectedWorkspaceRef.current !== workspaceAtStart
        if (isStale()) return
        await loadWorkspace(workspaceAtStart, isStale)
      } catch (err) {
        if (selectedWorkspaceRef.current !== workspaceAtStart) return
        setDuplicateError(err instanceof Error ? err.message : 'Failed to duplicate canvas.')
      } finally {
        setDuplicatingSlug((current) => (current === sourceSlug ? null : current))
      }
    },
    [daemonFetch, daemonBaseUrl, selectedWorkspace, rows, loadWorkspace, duplicatingSlug],
  )

  return (
    <DaemonApiContext.Provider value={daemonFetch}>
      <div className="flex h-full flex-col overflow-y-auto p-4">
        <h1 className="sr-only">Canvases</h1>
        <div className="mb-4 flex flex-wrap items-center gap-2 border-b pb-2">
          {workspaces.length > 1 && (
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
          <div className="ml-auto flex items-center gap-1">
            {/* One canvas surface, two projections: the toggle switches how
                the SAME list renders (thumbnail grid / alias tree+preview)
                instead of the former Canvases-vs-Files tab split. */}
            <div className="flex items-center gap-0.5 rounded-md border p-0.5">
              <button
                type="button"
                aria-label="Grid view"
                aria-pressed={view === 'grid'}
                onClick={() => setView('grid')}
                className="rounded p-1.5 text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
              >
                <LayoutGrid className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Tree view"
                aria-pressed={view === 'tree'}
                onClick={() => setView('tree')}
                className="rounded p-1.5 text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
              >
                <ListTree className="size-4" />
              </button>
            </div>
            <button
              type="button"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Settings className="size-4" />
            </button>
          </div>
        </div>

        {createError && (
          <div role="alert" className="mb-2 text-sm text-destructive">
            {createError}
          </div>
        )}
        {duplicateError && (
          <div role="alert" className="mb-2 text-sm text-destructive">
            {duplicateError}
          </div>
        )}

        {view === 'tree' ? (
          selectedWorkspace ? (
            // The wrapper remounts on every grid/tree toggle, so the fade
            // re-runs and the view switch reads as one continuous surface
            // changing shape rather than an instant swap.
            <div className="animate-in fade-in-0 duration-(--motion-duration-normal) ease-(--motion-ease-out)">
              <WorkspaceFilesPanel
                daemonFetch={daemonFetch}
                daemonBaseUrl={daemonBaseUrl}
                workspaceId={selectedWorkspace}
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No workspace selected.</p>
          )
        ) : loadError ? (
          <div role="alert" className="text-sm text-destructive">
            {loadError}
          </div>
        ) : !loaded ? (
          <div
            role="status"
            aria-label="Loading canvases"
            className="skeleton-appear grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
          >
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse rounded-lg border p-2">
                <div className="aspect-[4/3] rounded-md bg-muted" />
                <div className="mt-2 h-4 w-2/3 rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : (
          // Mounts when the skeleton unmounts: the fade carries the
          // skeleton-to-content handoff instead of an instant swap.
          <div className="animate-in fade-in-0 duration-(--motion-duration-normal) ease-(--motion-ease-out)">
            <CanvasListView
              rows={rows.map((row) => ({
                slug: row.slug,
                displayName: row.displayName,
                // The slug is worth a second line only when a display name
                // covers the first; unnamed canvases already show it once.
                secondary: row.displayName !== row.slug ? row.slug : undefined,
                updatedAt: row.updatedAt,
                kind: row.kind,
              }))}
              onOpen={(slug) => selectedWorkspace && onOpenCanvas(selectedWorkspace, slug)}
              onCreate={(kind) => void handleCreate(kind)}
              createDisabled={creating}
              renderThumb={(row) => (
                <CanvasThumb workspaceId={selectedWorkspace ?? ''} slug={row.slug} size="card" />
              )}
              renderActions={(row) => (
                <button
                  type="button"
                  aria-label={`Duplicate ${row.displayName}`}
                  disabled={duplicatingSlug === row.slug}
                  onClick={(event) => {
                    // Prevents the click from bubbling to the wrapping open-button.
                    event.stopPropagation()
                    void handleDuplicate(row.slug)
                  }}
                  className="absolute right-1 top-1 rounded-md border bg-background px-1.5 py-0.5 text-xs font-medium opacity-0 transition-opacity hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-100 disabled:cursor-not-allowed"
                >
                  Duplicate
                </button>
              )}
            />
          </div>
        )}
        <SettingsPanel
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          theme={theme}
          onThemeChange={setTheme}
          webMcpEnabled={webMcpEnabled}
          onWebMcpChange={setWebMcpEnabled}
          extraSections={
            <>
              <section aria-label="Paired web apps">
                <PairedOriginsCard />
              </section>
              <section aria-label="Storage">
                <StorageReportCard />
              </section>
            </>
          }
        />
      </div>
    </DaemonApiContext.Provider>
  )
}
