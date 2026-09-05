import type { WorkspaceSummary } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
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
// time — the one the ADDRESS names. Choosing which is the shell switcher's,
// not this page's: the workspace is the outermost layer of
// `/w/:workspace/d/:path`, so it is present on the document page too, and a
// control only reachable from this list could not change it from there.
// Modeled on the original daemon-served UI's IndexPage filter/sort/pin logic
// (since retired), but single-workspace rather than the all-workspace flat
// list that IndexPage rendered (see the design note for why).

export interface DaemonIndexPageProps {
  daemonBaseUrl: string
  token?: string
  capabilities?: WhiteboardCapabilities
  /**
   * The workspace the ADDRESS names, in either of ADR-0019's resolvable
   * layers. Absent when the address names none — `/`, or a workspace-level
   * pairing link without one — and the page then falls back to the daemon's
   * first-listed workspace and reports what it settled on.
   *
   * Not `initialWorkspaceId` any more, and the rename is the change: this
   * page used to OWN the choice through a select of its own, so the prop was
   * read once at mount. The one switcher is the shell's, and it moves the
   * address — so the prop changes under a mounted page, and the page follows
   * it.
   */
  workspace?: string
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
  workspace,
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

  // Read through a ref so `loadWorkspaces` stays stable across renders — the
  // mount effect below stays load-once, and the retry controls can share the
  // same function. The effect that FOLLOWS this prop is separate, below,
  // precisely so a changing address does not re-list the daemon.
  const addressedWorkspaceRef = useRef(workspace)
  addressedWorkspaceRef.current = workspace

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
      const targeted = addressedWorkspaceRef.current
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

  // The address moved, so the page moves.
  //
  // Resolved through the LIST, not set verbatim, and both guards below are a
  // workspace the page would otherwise lose:
  //
  // - `undefined` is not a move. `/` names no workspace, and the answer is
  //   whatever the list load picked; running on undefined would unselect it
  //   and leave the page with nothing on screen.
  // - A handle the list does not hold is a STALE address — a bookmark of a
  //   deleted workspace — and the standing behaviour is to fall back to
  //   first-listed rather than to select something the daemon will 404. Set
  //   verbatim, this effect overrode that fallback, which is what its test
  //   caught.
  //
  // `resolveWorkspaceHandle` because the address may carry either of
  // ADR-0019's layers, and matching segments alone would miss the canonical
  // id form and silently open a different workspace.
  // Keyed on the SETTLED value, not on the act of choosing: the initial
  // resolve and a switch reach the address bar the same way, because to a
  // reader they are the same fact — this is the workspace you are looking at.
  // A re-render that did not move it reports nothing, which is why the stale
  // -address branch above has to clear this deliberately.
  const reportedWorkspaceRef = useRef<string | null>(null)

  // The handles this page has already re-read the list for. A miss has two
  // causes that look identical from here, and only one of them is stale.
  const refetchedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (workspace === undefined || !workspacesLoaded) return
    const wanted = resolveWorkspaceHandle(workspaces, workspace)
    // A handle this list does not hold is EITHER a stale bookmark or a
    // workspace the switcher created or renamed a moment ago. The switcher is
    // the SHELL's and writes through its own source, so this page's list is a
    // snapshot taken before that write — and treating every miss as stale
    // meant creating a workspace landed on a DIFFERENT one and rewrote the
    // address to name it. So a miss re-reads the list once per handle; a
    // handle still missing after that is genuinely stale and gets the
    // first-listed fallback below, unchanged.
    if (wanted === null && refetchedForRef.current !== workspace) {
      refetchedForRef.current = workspace
      // Unselected for the duration, and that is the load-bearing half. The
      // re-read can FAIL, and leaving the previous workspace selected under an
      // address naming another is the mismatch the stale-address branch below
      // exists to refuse: the error state offers `Create a canvas` while
      // something is selected, so a create there would post the document to
      // the workspace the URL does not name. With nothing selected the same
      // state offers `Try again`, which is the only honest action while the
      // address is unresolved. On success `loadWorkspaces` selects the
      // addressed workspace itself, since there is no current value to keep.
      setSelectedWorkspace(null)
      void loadWorkspaces()
      return
    }
    const fallback = workspaces[0]
    const target = wanted ?? fallback
    if (target === undefined) return
    const handle = workspaceHandle(target)
    setSelectedWorkspace((current) => (current === handle ? current : handle))
    if (wanted !== null) return
    // A STALE address — a bookmark of a workspace that is gone, opened while
    // the app is already running. The page falls back to first-listed, which
    // is the standing behaviour, but the fallback has to reach the ADDRESS
    // too. Returning here left the page on one workspace under an address
    // naming another, and every document created then landed somewhere the
    // URL did not say.
    //
    // Reported straight from here rather than by clearing the ref below: the
    // fallback is usually the workspace already selected, so the reporting
    // effect never re-runs — its deps did not move, and a ref is not a dep.
    // Marking it reported in the same breath is what keeps this to ONE call
    // when the fallback IS a different workspace and that effect does fire.
    reportedWorkspaceRef.current = handle
    onWorkspaceResolved?.(handle)
  }, [workspace, workspaces, workspacesLoaded, onWorkspaceResolved, loadWorkspaces])

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

  // SCOPE RESET — see scoped-screen-state.test.ts
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
    // Same rule, one level up: a DIALOG holding a path is the mismatched
    // identity the rows-clear above exists to prevent, and it outlives the
    // switch that the rows do not. `handleConfirmDelete` reads
    // `selectedWorkspace` when the button is pressed, not when the dialog
    // opened, so confirming after a switch sends the departed workspace's
    // path to the one now on screen. Measured before this line existed:
    // opening Delete on ws-a's `untitled`, switching to ws-b and confirming
    // sent `DELETE ws-b/untitled` — a document nobody selected.
    setPendingDelete(null)
    setDeleteError(null)
    setDuplicatingPath(null)
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
    // A LIST, so one confirmation and one handler serve both the single
    // delete and the selection's bulk delete. A single delete is a list of
    // one, and keeps naming its document.
    paths: readonly string[]
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
      // Sequential, and each failure recorded rather than thrown: one path
      // the daemon refuses must not abandon the rest, and the person has to
      // be told how many did not go.
      const failed: string[] = []
      let lastError: unknown = null
      for (const path of pendingDelete.paths) {
        try {
          await deleteDocument(daemonFetch, daemonBaseUrl, workspaceAtStart, path)
        } catch (err) {
          failed.push(path)
          lastError = err
        }
      }
      if (failed.length > 0) {
        // Not closed: the list behind the dialog has already changed, and
        // closing silently would read as "all deleted". The panel's own
        // pruning leaves exactly the failures selected.
        setDeleteError(
          failed.length === pendingDelete.paths.length
            ? lastError instanceof Error
              ? lastError.message
              : 'Failed to delete document.'
            : `${failed.length} of ${pendingDelete.paths.length} could not be deleted.`,
        )
        return
      }
      closeDeleteDialog()
    } catch (err) {
      // daemon-api-client errors are already sanitized (problem-details
      // title or a generic status message) — safe to surface directly.
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete document.')
    } finally {
      setDeleting(false)
    }
  }, [daemonFetch, daemonBaseUrl, selectedWorkspace, pendingDelete, closeDeleteDialog])

  // What the page calls itself. `selectedWorkspace` holds a HANDLE, not an id,
  // so the row is found through `resolveWorkspaceHandle` — the same reason the
  // loader above gives, one layer up. `workspaceLabel` owns the precedence
  // across ADR-0019's three layers; re-deriving it here is how a site ends up
  // knowing about fewer layers than there are.
  //
  // The fallbacks are each a true statement about where you are, in order of
  // how much they say: the name, then the handle the address carries, then
  // the generic word for the moments before any workspace is known (this page
  // also mounts at `/`, where there is no handle to fall back to). The
  // heading is never absent — a document browser with no h1 is a worse
  // outcome than a generic one.
  const activeWorkspace =
    selectedWorkspace === null ? null : resolveWorkspaceHandle(workspaces, selectedWorkspace)
  const pageHeading =
    (activeWorkspace ? workspaceLabel(activeWorkspace) : null) ??
    selectedWorkspace ??
    workspace ??
    'Documents'

  return (
    <DaemonApiContext.Provider value={daemonFetch}>
      <div className="flex h-full flex-col overflow-y-auto p-4">
        <h1 className="mb-3 truncate text-lg font-semibold">{pageHeading}</h1>
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
          // Creation is offered by the SWITCHER, not here — one carrier, the
          // same one every other page uses. This state points at it rather
          // than growing a second create control beside it.
          //
          // It used to say the write was someone else's, and that was true
          // while every create path addressed a (workspace, path) pair this
          // page could not name. `POST /api/workspaces` retired that: the
          // daemon mints the id and derives the address from a display name,
          // so the client no longer has to guess an identifier the daemon
          // would agree with.
          <div className="flex flex-col items-start gap-3">
            <div>
              <p className="text-sm font-medium">This daemon has no workspaces.</p>
              <p className="text-sm text-muted-foreground">
                Create one from the workspace menu in the header — or one appears on its own once an
                agent over MCP, or the whiteboard CLI, writes a document.
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
              // The handle the address carries, which is exactly what a
              // document's URL under this workspace is built from.
              workspace={selectedWorkspace}
              initialFolder={routedFolder}
              onFolderChange={setRoutedFolder}
              onOpenDocument={(path) => onOpenDocument(selectedWorkspace, path)}
              onDuplicateDocument={(path) => void handleDuplicate(path)}
              onRequestDelete={(path, displayName, kind) =>
                setPendingDelete({ paths: [path], displayName, kind })
              }
              onRequestDeleteMany={(paths) =>
                setPendingDelete({ paths, displayName: `${paths.length} documents` })
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
          pending={
            pendingDelete === null
              ? null
              : {
                  displayName: pendingDelete.displayName,
                  ...(pendingDelete.kind === undefined ? {} : { kind: pendingDelete.kind }),
                  ...(pendingDelete.paths.length > 1 ? { count: pendingDelete.paths.length } : {}),
                }
          }
          busy={deleting}
          error={deleteError}
          action={
            pendingDelete !== null && pendingDelete.paths.length > 1
              ? 'delete-documents-daemon'
              : 'delete-document-daemon'
          }
          onCancel={closeDeleteDialog}
          onConfirm={() => void handleConfirmDelete()}
        />
      </div>
    </DaemonApiContext.Provider>
  )
}
