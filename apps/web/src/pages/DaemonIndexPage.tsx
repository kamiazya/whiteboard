import type { WorkspaceSummary } from '@kamiazya/whiteboard-mcp/api-contracts'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { resolveWorkspaceHandle } from '@kamiazya/whiteboard-ports'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DeleteDocumentDialog } from '../components/document-list/DeleteDocumentDialog.js'
import { EmptyWorkspaceState } from '../components/workspace-files/EmptyWorkspaceState.js'
import { WorkspaceFilesPanel } from '../components/workspace-files/WorkspaceFilesPanel.js'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { useRoutedFolder } from '../hooks/useRoutedFolder.js'
import {
  createDaemonFetch,
  createDocument,
  DaemonApiError,
  deleteDocument,
  getDocumentSnapshot,
  getWorkspaceNames,
  listDocuments,
  listTrash,
  listWorkspaces,
  setDocumentDisplayName,
  updateDocument,
} from '../lib/daemon-api-client.js'
import { createDaemonFilesSource } from '../lib/daemon-files-source.js'
import { deriveCopyName } from '../lib/derive-copy-name.js'
import { deriveCopyPath } from '../lib/derive-copy-path.js'
import { deriveNewDocumentPath } from '../lib/derive-new-document-path.js'
import { kindNoun } from '../lib/kind-noun.js'
import type { WhiteboardCapabilities } from '../lib/provider.js'
import { workspaceHandle, workspaceLabel } from '../lib/workspace-handle.js'

// The document browser for a connected daemon, scoped to ONE workspace at a
// time — the workspace selector picks which workspace the panel shows.
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
  /**
   * The workspace this page settled on — the initial resolve as well as every
   * later switch. The address bar is App's to write, and until this existed it
   * had nothing to write WITH: `/` names no workspace, the page picked one
   * anyway, and the two disagreed for the rest of the session.
   */
  onWorkspaceResolved?: (workspace: string) => void
  onOpenDocument: (workspaceId: string, path: string) => void
}

interface DocumentRow {
  path: string
  displayName: string
  updatedAt: string | undefined
  // Absent when the daemon records no kind for the row (pre-kind documents):
  // the list says nothing rather than claiming spatial.
  kind?: DocumentKind
  pinned: boolean
  pinOrder: number
}

function sortRows(rows: DocumentRow[]): DocumentRow[] {
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.pinned && b.pinned) return a.pinOrder - b.pinOrder
    // Newest first, and a document with no recorded timestamp sorts last
    // rather than winning by accident: `undefined` fails every `<`
    // comparison, so a bare `a.updatedAt < b.updatedAt` would have quietly
    // ordered it as if it were the newest.
    const left = a.updatedAt ?? ''
    const right = b.updatedAt ?? ''
    if (left !== right) return left < right ? 1 : -1
    return 0
  })
}

export function DaemonIndexPage({
  daemonBaseUrl,
  token,
  initialWorkspaceId,
  onWorkspaceResolved,
  onOpenDocument,
}: DaemonIndexPageProps) {
  const daemonFetch = useMemo(() => createDaemonFetch(daemonBaseUrl, token), [daemonBaseUrl, token])

  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  // Whether the workspace LIST has settled, which `workspaces.length === 0`
  // alone cannot say — it reads the same before the first fetch returns and
  // after a daemon answers with nothing. Only the second of those is a state
  // to render; the first is still loading.
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false)
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null)
  // One source per (fetch, base, workspace): the panel re-reads whenever the
  // source identity changes, so this memo is also what scopes it to the
  // selected workspace.
  const filesSource = useMemo(
    () =>
      selectedWorkspace
        ? createDaemonFilesSource(daemonFetch, daemonBaseUrl, selectedWorkspace)
        : null,
    [daemonFetch, daemonBaseUrl, selectedWorkspace],
  )
  const [rows, setRows] = useState<DocumentRow[]>([])
  // Consulted only for the onboarding decision: a workspace whose list is
  // empty but whose trash is not must keep the PANEL, because the Trash
  // section is the one affordance that undoes the delete that just emptied
  // the list. Failure degrades to 0 — onboarding — never to an error. The
  // same rule BrowserIndexPage keeps for the browser keeper.
  const [trashCount, setTrashCount] = useState(0)
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

  // initialWorkspaceId is fixed for the page's lifetime (set once from the
  // pairing payload App.tsx resolved at mount), so reading it through a ref
  // keeps loadWorkspaces stable across renders — the mount effect below stays
  // load-once, and the retry controls can share the same function.
  const initialWorkspaceIdRef = useRef(initialWorkspaceId)
  initialWorkspaceIdRef.current = initialWorkspaceId

  // Orders every list load, so only the newest one may write. The retry
  // controls can overlap freely — nothing else sequences two presses — and an
  // older answer landing last does not merely leave a stale message: the
  // no-workspaces branch keys on `workspaces.length === 0` alone, so the page
  // reverts to it with a workspace selected and its documents on screen.
  //
  // This replaces the `isStale` callback the sibling loaders take, rather than
  // joining it. That callback asks whether the CALLER still cares, which only
  // the mount effect can answer; a dep change already bumps the generation
  // here (the cleanup runs, then the re-run), leaving it covering unmount
  // alone — a setState no-op since React 18, and nothing a test can tell apart
  // from its absence. Measured: with it removed, all 46 cases stay green.
  const listGeneration = useRef(0)

  const loadWorkspaces = useCallback(async () => {
    const generation = ++listGeneration.current
    const superseded = () => generation !== listGeneration.current
    setLoadError(null)
    try {
      const res = await listWorkspaces(daemonFetch, daemonBaseUrl)
      if (superseded()) return
      setWorkspaces(res.workspaces)
      setWorkspacesLoaded(true)
      const targeted = initialWorkspaceIdRef.current
      // Through `resolveWorkspaceHandle`, not an `includes`: the URL may carry
      // EITHER layer — the segment a person reads, or the canonical id that
      // survives a rename — and an id-form address matched against segments
      // alone would miss and silently open a different workspace.
      const wanted = targeted ? resolveWorkspaceHandle(res.workspaces, targeted) : null
      const first = res.workspaces[0]
      setSelectedWorkspace(
        (current) =>
          current ??
          (wanted ? workspaceHandle(wanted) : undefined) ??
          (first ? workspaceHandle(first) : undefined) ??
          null,
      )
    } catch {
      if (superseded()) return
      setWorkspacesLoaded(true)
      setLoadError('Failed to load workspaces.')
    }
  }, [daemonFetch, daemonBaseUrl])

  useEffect(() => {
    void loadWorkspaces()
  }, [loadWorkspaces])

  // Keyed on the SETTLED value, not on the act of choosing: the initial
  // resolve and a dropdown switch reach the address bar the same way, because
  // to a reader they are the same fact — this is the workspace you are
  // looking at. A re-render that did not move it reports nothing.
  const reportedWorkspaceRef = useRef<string | null>(null)
  useEffect(() => {
    if (selectedWorkspace === null) return
    if (reportedWorkspaceRef.current === selectedWorkspace) return
    reportedWorkspaceRef.current = selectedWorkspace
    onWorkspaceResolved?.(selectedWorkspace)
  }, [selectedWorkspace, onWorkspaceResolved])

  // Re-reads the workspace list and moves off the one that vanished.
  //
  // Deliberately picks a workspace OTHER than the stale id even if the server
  // still lists it: were the two to disagree, selecting it again would send
  // the page straight back into this path and loop. Choosing a different one
  // — or nothing — always terminates, and the dropdown still lets a person
  // pick it by hand.
  const reselectAfterStale = useCallback(
    async (staleWorkspaceId: string, isStale: () => boolean) => {
      try {
        const res = await listWorkspaces(daemonFetch, daemonBaseUrl)
        if (isStale()) return
        setWorkspaces(res.workspaces)
        const next = res.workspaces.map(workspaceHandle).find((h) => h !== staleWorkspaceId)
        if (next === undefined) {
          // Nothing to move to — this was the only workspace, or the list and
          // the documents disagree about it. Re-selecting the same one would
          // come straight back here forever, and leaving the page in its
          // loading state would spin without end. Say so instead: the request
          // that failed is the one the person is waiting on.
          setLoaded(true)
          setLoadError('Failed to load documents for this workspace.')
          return
        }
        // A real replacement re-enters the selection effect, which clears
        // `loaded` itself and owns it from there.
        setSelectedWorkspace(next)
      } catch {
        if (isStale()) return
        setLoadError('Failed to load workspaces.')
      }
    },
    [daemonFetch, daemonBaseUrl],
  )

  const loadWorkspace = useCallback(
    async (workspaceId: string, isStale: () => boolean) => {
      setLoadError(null)
      try {
        const [documentsRes, names, trashEntries] = await Promise.all([
          listDocuments(daemonFetch, daemonBaseUrl, workspaceId),
          // Failure degrades to "nothing named, nothing pinned", never to a
          // failed list.
          getWorkspaceNames(daemonFetch, daemonBaseUrl, workspaceId).catch(() => null),
          // Loaded HERE because this runs after every delete too (the dialog
          // dismiss re-invokes it), which is exactly when the count decides
          // whether onboarding may replace the panel.
          listTrash(daemonFetch, daemonBaseUrl, workspaceId)
            .then((res) => res.entries.length)
            .catch(() => 0),
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
        setTrashCount(trashEntries)
        setLoaded(true)
      } catch (err) {
        if (isStale()) return
        setRows([])
        // A 404 means the workspace is GONE, not empty. An existing workspace
        // with no documents answers 200 with an empty array; only an absent
        // one 404s. And `selectedWorkspace` is only ever set from
        // `GET /api/workspaces`, so the sole way to arrive here is that the
        // workspace was deleted AFTER that list was taken — by an agent,
        // another tab, or the CLI.
        //
        // So the selection is what went stale, and re-listing is the repair.
        // Rendering the empty create-into-it state instead would hide a real
        // anomaly, and a create issued against a workspace that no longer
        // exists would silently make a DIFFERENT one (the route passes
        // `createWorkspace: true`).
        if (err instanceof DaemonApiError && err.status === 404) {
          // Deliberately NOT `setLoaded(true)` here. The load is not over —
          // the page is still deciding what it is showing. Marking it
          // complete renders the onboarding empty state for the workspace
          // that just vanished, with a live Create button that passes
          // `createWorkspace: true`, so a click inside this window would
          // silently make a DIFFERENT workspace. `reselectAfterStale` sets it
          // only once there is nothing left to choose.
          void reselectAfterStale(workspaceId, isStale)
          return
        }
        setLoaded(true)
        setLoadError('Failed to load documents for this workspace.')
      }
    },
    [daemonFetch, daemonBaseUrl, reselectAfterStale],
  )

  useEffect(() => {
    if (!selectedWorkspace) return
    let cancelled = false
    // Clear synchronously BEFORE the async load: leaving the previous
    // workspace's rows visible during the switch lets a click pair the new
    // workspace id with an old workspace's path — a mismatched identity.
    setRows([])
    setTrashCount(0)
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
  const { folder: routedFolder, setFolder: setRoutedFolder } = useRoutedFolder()

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
        setCreateError(err instanceof Error ? err.message : `Failed to create ${kindNoun(kind)}.`)
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
  // browser controller's read-then-write duplicate flow rather than
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
        setDuplicateError(err instanceof Error ? err.message : 'Failed to duplicate document.')
      } finally {
        setDuplicatingPath((current) => (current === sourcePath ? null : current))
      }
    },
    [daemonFetch, daemonBaseUrl, selectedWorkspace, rows, loadWorkspace, duplicatingPath],
  )

  const [pendingDelete, setPendingDelete] = useState<{
    path: string
    displayName: string
    kind?: DocumentKind
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
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete document.')
    } finally {
      setDeleting(false)
    }
  }, [daemonFetch, daemonBaseUrl, selectedWorkspace, pendingDelete, closeDeleteDialog])

  return (
    <DaemonApiContext.Provider value={daemonFetch}>
      <div className="flex h-full flex-col overflow-y-auto p-4">
        <h1 className="sr-only">Documents</h1>
        <div className="mb-4 flex flex-wrap items-center gap-2 border-b pb-2">
          {workspaces.length > 1 && (
            <select
              aria-label="Workspace"
              value={selectedWorkspace ?? ''}
              onChange={(event) => setSelectedWorkspace(event.target.value)}
              className="rounded-md border bg-background px-2 py-1 text-sm"
            >
              {workspaces.map((w) => (
                <option key={w.workspaceId} value={workspaceHandle(w)}>
                  {workspaceLabel(w)}
                </option>
              ))}
            </select>
          )}
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

        {loadError ? (
          // A failed list load must not dead-end the page: the POST needs no
          // rows and success navigates away, so creating remains a recovery
          // path around the broken list. The transient loading state below
          // deliberately has no create control — deriving a path from rows
          // that are still in flight invites a collision the loaded states
          // cannot produce.
          //
          // Which failed decides which recovery is real. Creating needs a
          // workspace to create INTO, so when the WORKSPACE list is what
          // failed there is nothing selected and `handleCreate` returns at its
          // first line — the button would sit there doing nothing. Offer the
          // request that failed instead.
          <div className="flex flex-col items-start gap-3">
            <div role="alert" className="text-sm text-destructive">
              {loadError}
            </div>
            {selectedWorkspace ? (
              <button
                type="button"
                disabled={creating}
                onClick={() => void handleCreate('spatial')}
                className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
              >
                Create a canvas
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void loadWorkspaces()}
                className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
              >
                Try again
              </button>
            )}
          </div>
        ) : workspacesLoaded && workspaces.length === 0 ? (
          // A daemon that holds no workspaces at all. Nothing is selected, so
          // the documents fetch that ends the loading state never runs and the
          // skeleton below would spin for as long as the page stays open.
          //
          // There is no create control here on purpose: every create path
          // addresses a (workspace, path) pair, and this page has no way to
          // name a workspace the daemon would agree with — the daemon keeps
          // its own current workspace id and does not publish it. So the one
          // honest action is to look again, because the write that fixes this
          // is someone else's.
          <div className="flex flex-col items-start gap-3">
            <div>
              <p className="text-sm font-medium">This daemon has no workspaces.</p>
              <p className="text-sm text-muted-foreground">
                A workspace appears once something creates a document in it — an agent over MCP, or
                the whiteboard CLI.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadWorkspaces()}
              className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
            >
              Check again
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
        ) : rows.length === 0 && trashCount === 0 ? (
          // The onboarding state renders INSTEAD of the panel: a three-pane
          // browser of nothing teaches less than one sentence and one
          // button, and this button also OPENS what it creates (ADR-0006 —
          // naming happens in the opened document's own top bar).
          <EmptyWorkspaceState
            onCreate={(kind) => void handleCreate(kind)}
            disabled={creating}
            subtitle="Documents live in this workspace, kept by your local daemon."
          />
        ) : selectedWorkspace && filesSource ? (
          // Mounts when the skeleton unmounts: the fade carries the
          // skeleton-to-content handoff instead of an instant swap.
          <div className="animate-in fade-in-0 duration-(--motion-duration-normal) ease-(--motion-ease-out)">
            <WorkspaceFilesPanel
              source={filesSource}
              initialFolder={routedFolder}
              onFolderChange={setRoutedFolder}
              onOpenDocument={(path) => onOpenDocument(selectedWorkspace, path)}
              onDuplicateDocument={(path) => void handleDuplicate(path)}
              onRequestDelete={(path, displayName, kind) =>
                setPendingDelete({ path, displayName, kind })
              }
              // A new array on every successful read, which is exactly the
              // signal the panel needs: the page reloads this list after a
              // duplicate and after a delete, both of which it performs on
              // the panel's behalf.
              revision={rows}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No workspace selected.</p>
        )}
        <DeleteDocumentDialog
          pending={pendingDelete}
          busy={deleting}
          error={deleteError}
          description={`This permanently removes the ${kindNoun(pendingDelete?.kind)}, including its versions and branches. There is no undo.`}
          onCancel={closeDeleteDialog}
          onConfirm={() => void handleConfirmDelete()}
        />
      </div>
    </DaemonApiContext.Provider>
  )
}
