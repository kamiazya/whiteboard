import { workspaceNamesSchema } from '@kamiazya/whiteboard-mcp/api-contracts'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { LayoutGrid, ListTree } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { z } from 'zod'
import { DocumentThumb } from '../components/DocumentThumb.js'
import { DeleteDocumentDialog } from '../components/document-list/DeleteDocumentDialog.js'
import { DocumentListView } from '../components/document-list/DocumentListView.js'
import { WorkspaceFilesPanel } from '../components/workspace-files/WorkspaceFilesPanel.js'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import {
  createDaemonFetch,
  createDocument,
  deleteDocument,
  getDocumentSnapshot,
  listDocuments,
  listWorkspaces,
  setDocumentDisplayName,
  updateDocument,
} from '../lib/daemon-api-client.js'
import { deriveCopyName } from '../lib/derive-copy-name.js'
import { deriveCopyPath } from '../lib/derive-copy-path.js'
import { deriveNewDocumentPath } from '../lib/derive-new-document-path.js'
import type { WhiteboardCapabilities } from '../lib/provider.js'

// A gallery for a connected daemon, scoped to ONE workspace at a time — the
// workspace selector picks which workspace's documents populate the grid.
// Modeled on the original daemon-served UI's IndexPage filter/sort/pin logic
// (since retired), but single-workspace rather than the all-workspace flat
// list that IndexPage rendered (see the design note for why).

export interface DaemonIndexPageProps {
  daemonBaseUrl: string
  token?: string
  capabilities?: WhiteboardCapabilities
  // A workspace-level pairing link (#wb= with workspaceId but no path) names
  // a specific workspace to land on; falls back to the daemon's first-listed
  // workspace when absent, or when the named workspace isn't in the list.
  initialWorkspaceId?: string
  onOpenDocument: (workspaceId: string, path: string) => void
}

interface DocumentRow {
  path: string
  displayName: string
  updatedAt: string
  // Absent when the daemon records no kind for the row (pre-kind documents):
  // the list says nothing rather than claiming spatial.
  kind?: DocumentKind
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

function sortRows(rows: DocumentRow[]): DocumentRow[] {
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
  onOpenDocument,
}: DaemonIndexPageProps) {
  const daemonFetch = useMemo(() => createDaemonFetch(daemonBaseUrl, token), [daemonBaseUrl, token])

  const [view, setView] = useState<ViewKey>('grid')
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null)
  const [rows, setRows] = useState<DocumentRow[]>([])
  // False from the moment a workspace switch clears rows until its documents
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
  const [duplicatingPath, setDuplicatingPath] = useState<string | null>(null)
  // Disables both create controls while one is in flight, so a second press cannot send another
  // POST deriving the identical path from the same rows. The `disabled` attribute is the whole
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
        const [documentsRes, names] = await Promise.all([
          listDocuments(daemonFetch, daemonBaseUrl, workspaceId),
          fetchWorkspaceNames(daemonFetch, daemonBaseUrl, workspaceId),
        ])
        if (isStale()) return
        const pinIndex = new Map((names?.pinned ?? []).map((path, i) => [path, i]))
        const nextRows: DocumentRow[] = documentsRes.documents.map((c) => {
          const pinOrder = pinIndex.get(c.path)
          return {
            path: c.path,
            displayName: names?.documents?.[c.path] ?? c.path,
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
        setLoadError('Failed to load documents for this workspace.')
      }
    },
    [daemonFetch, daemonBaseUrl],
  )

  useEffect(() => {
    if (!selectedWorkspace) return
    let cancelled = false
    // Clear synchronously BEFORE the async load: leaving the previous
    // workspace's rows visible during the switch lets a click pair the new
    // workspace id with an old workspace's path — a mismatched identity.
    setRows([])
    setLoaded(false)
    setLoadError(null)
    void loadWorkspace(selectedWorkspace, () => cancelled)
    return () => {
      cancelled = true
    }
  }, [selectedWorkspace, loadWorkspace])

  // Creation is immediate — no name is collected up front (ADR-0006 point
  // 3). A path is derived from the loaded rows so it never collides with a
  // canvas already in the list; naming happens afterwards, in the opened
  // canvas's own top bar.
  const handleCreate = useCallback(
    async (kind: DocumentKind) => {
      if (!selectedWorkspace) return
      const workspaceAtStart = selectedWorkspace
      setCreating(true)
      setCreateError(null)
      try {
        const path = deriveNewDocumentPath(rows.map((r) => r.path))
        const created = await createDocument(
          daemonFetch,
          daemonBaseUrl,
          workspaceAtStart,
          path,
          kind,
        )
        onOpenDocument(workspaceAtStart, created.path)
      } catch (err) {
        // daemon-api-client errors are already sanitized (Problem Details
        // title or a generic status message) — safe to surface directly.
        setCreateError(err instanceof Error ? err.message : 'Failed to create canvas.')
        // The path is derived from `rows`, so a failure caused by a name this list has not seen
        // (another tab, a lost race) would otherwise re-derive the SAME path on every retry and
        // collide forever. Re-read the list so the next derive skips what is actually taken.
        const isStale = () => selectedWorkspaceRef.current !== workspaceAtStart
        if (!isStale()) await loadWorkspace(workspaceAtStart, isStale)
      } finally {
        setCreating(false)
      }
    },
    [daemonFetch, daemonBaseUrl, selectedWorkspace, rows, onOpenDocument, loadWorkspace],
  )

  // Client-side copy through EXISTING daemon HTTP endpoints only (read
  // snapshot -> create canvas -> write snapshot -> rename), matching the
  // browser-local controller's read-then-write duplicate flow rather than
  // requiring a dedicated server-side "duplicate" endpoint.
  const handleDuplicate = useCallback(
    async (sourcePath: string) => {
      if (duplicatingPath !== null) return
      const workspaceAtStart = selectedWorkspace
      if (!workspaceAtStart) return
      setDuplicatingPath(sourcePath)
      setDuplicateError(null)
      const sourceRow = rows.find((r) => r.path === sourcePath)
      // The whole operation targets workspaceAtStart, not whatever the user
      // has switched the selector to by the time each await resolves — a
      // duplicate started in one workspace must finish in that SAME
      // workspace even if the user has since switched away from it. Applying
      // its completion (the rows refresh) to the page is gated separately,
      // below, on whether that workspace is still the one being viewed.
      try {
        const snapshot = await getDocumentSnapshot(
          daemonFetch,
          daemonBaseUrl,
          workspaceAtStart,
          sourcePath,
        )
        const existingPaths = new Set(rows.map((r) => r.path))
        const newPath = deriveCopyPath(sourcePath, existingPaths)
        const created = await createDocument(daemonFetch, daemonBaseUrl, workspaceAtStart, newPath)
        await updateDocument(daemonFetch, daemonBaseUrl, workspaceAtStart, created.path, snapshot)
        const existingNames = new Set(rows.map((r) => r.displayName))
        const newName = deriveCopyName(sourceRow?.displayName ?? sourcePath, existingNames)
        await setDocumentDisplayName(
          daemonFetch,
          daemonBaseUrl,
          workspaceAtStart,
          created.path,
          newName,
        )
        const isStale = () => selectedWorkspaceRef.current !== workspaceAtStart
        if (isStale()) return
        await loadWorkspace(workspaceAtStart, isStale)
      } catch (err) {
        if (selectedWorkspaceRef.current !== workspaceAtStart) return
        setDuplicateError(err instanceof Error ? err.message : 'Failed to duplicate canvas.')
      } finally {
        setDuplicatingPath((current) => (current === sourcePath ? null : current))
      }
    },
    [daemonFetch, daemonBaseUrl, selectedWorkspace, rows, loadWorkspace, duplicatingPath],
  )

  const [pendingDelete, setPendingDelete] = useState<{
    path: string
    displayName: string
  } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Dismissing the dialog always refreshes the list: after a success the row
  // must go, and after a FAILURE the daemon's state is unknown from here —
  // a 404 means the canvas was already gone (another tab, an agent), and a
  // stale row lingering after any failed delete is worse than one refetch.
  const closeDeleteDialog = useCallback(() => {
    setPendingDelete(null)
    setDeleteError(null)
    const workspaceAtStart = selectedWorkspace
    if (!workspaceAtStart) return
    const isStale = () => selectedWorkspaceRef.current !== workspaceAtStart
    void loadWorkspace(workspaceAtStart, isStale)
  }, [selectedWorkspace, loadWorkspace])

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    const workspaceAtStart = selectedWorkspace
    if (!workspaceAtStart) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteDocument(daemonFetch, daemonBaseUrl, workspaceAtStart, pendingDelete.path)
      closeDeleteDialog()
    } catch (err) {
      // daemon-api-client errors are already sanitized (problem-details
      // title or a generic status message) — safe to surface directly.
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete canvas.')
    } finally {
      setDeleting(false)
    }
  }, [daemonFetch, daemonBaseUrl, selectedWorkspace, pendingDelete, closeDeleteDialog])

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
                onOpenDocument={(path) => onOpenDocument(selectedWorkspace, path)}
                onDuplicateDocument={(path) => void handleDuplicate(path)}
                onRequestDelete={(path, displayName) => setPendingDelete({ path, displayName })}
                // A new array on every successful read, which is exactly the
                // signal the panel needs: the page reloads this list after a
                // duplicate and after a delete, both of which it performs on
                // the panel's behalf.
                revision={rows}
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No workspace selected.</p>
          )
        ) : loadError ? (
          // A failed list load must not dead-end the page: the POST needs no
          // rows and success navigates away, so creating remains a recovery
          // path around the broken list. The transient loading state below
          // deliberately has no create control — deriving a path from rows
          // that are still in flight invites a collision the loaded states
          // cannot produce.
          <div className="flex flex-col items-start gap-3">
            <div role="alert" className="text-sm text-destructive">
              {loadError}
            </div>
            <button
              type="button"
              disabled={creating}
              onClick={() => void handleCreate('spatial')}
              className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
            >
              Create a canvas
            </button>
          </div>
        ) : !loaded ? (
          <div
            role="status"
            aria-label="Loading documents"
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
            <DocumentListView
              rows={rows.map((row) => ({
                path: row.path,
                displayName: row.displayName,
                // The path is worth a second line only when a display name
                // covers the first; unnamed documents already show it once.
                secondary: row.displayName !== row.path ? row.path : undefined,
                updatedAt: row.updatedAt,
                kind: row.kind,
              }))}
              onOpen={(path) => selectedWorkspace && onOpenDocument(selectedWorkspace, path)}
              onCreate={(kind) => void handleCreate(kind)}
              createDisabled={creating}
              renderThumb={(row) => (
                <DocumentThumb workspaceId={selectedWorkspace ?? ''} path={row.path} size="card" />
              )}
              renderActions={(row) => (
                <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <button
                    type="button"
                    aria-label={`Duplicate ${row.displayName}`}
                    disabled={duplicatingPath === row.path}
                    onClick={(event) => {
                      // Prevents the click from bubbling to the wrapping open-button.
                      event.stopPropagation()
                      void handleDuplicate(row.path)
                    }}
                    className="rounded-md border bg-background px-1.5 py-0.5 text-xs font-medium hover:bg-accent disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-100"
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${row.displayName}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      setPendingDelete({ path: row.path, displayName: row.displayName })
                    }}
                    className="rounded-md border bg-background px-1.5 py-0.5 text-xs font-medium hover:bg-accent"
                  >
                    Delete
                  </button>
                </div>
              )}
            />
          </div>
        )}
        <DeleteDocumentDialog
          pending={pendingDelete}
          busy={deleting}
          error={deleteError}
          description="This permanently removes the canvas, including its versions and branches. There is no undo."
          onCancel={closeDeleteDialog}
          onConfirm={() => void handleConfirmDelete()}
        />
      </div>
    </DaemonApiContext.Provider>
  )
}
