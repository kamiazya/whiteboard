import type { WorkspaceSummary } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { resolveWorkspaceHandle } from '@kamiazya/whiteboard-ports'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DeleteDocumentDialog } from '../components/document-list/DeleteDocumentDialog.js'
import { DaemonApiContext } from '../contexts/DaemonApiContext.js'
import { useRoutedFolder } from '../hooks/useRoutedFolder.js'
import {
  createDaemonFetch,
  createDocument,
  DaemonApiError,
  listWorkspaces,
} from '../lib/daemon-api-client.js'
import { createDaemonFilesSource } from '../lib/daemon-files-source.js'
import { deriveNewDocumentPath } from '../lib/derive-new-document-path.js'
import { duplicateDaemonDocument } from '../lib/duplicate-daemon-document.js'
import { WorkspaceMissingError } from '../lib/files-source.js'
import { kindNoun } from '../lib/kind-noun.js'
import { workspaceHandle, workspaceLabel } from '../lib/workspace-handle.js'
import { type DocumentRow, deleteEach, duplicateRequest } from './daemon-index-actions.js'
// What the list shows: a failed load with the recovery that is actually
// available, the transient loading state, onboarding, or the panel. Split out
// of the page body — each arm is a different screen, and the page is about
// deciding WHICH, not about drawing them.
import { DaemonIndexBody } from './daemon-index-body.js'
import { useDeleteDocuments } from './use-delete-documents.js'

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
  /** Served by a server-mode keeper (ADR-0047), so the copy names a server. */
  serverMode?: boolean
}

const WORKSPACE_GONE = 'This workspace is not on the daemon any more.'

// daemon-api-client errors are already sanitized (Problem Details title or a
// generic status message), so one is safe to show — except a 404, which on a
// create is the WORKSPACE, and whose reason is written for an MCP caller: it
// names a tool parameter.
function createFailureMessage(err: unknown, kind: DocumentKind): string {
  if (err instanceof DaemonApiError && err.status === 404) return WORKSPACE_GONE
  return err instanceof Error ? err.message : `Failed to create ${kindNoun(kind)}.`
}

/**
 * What the address resolves to, given the handles whose documents answered
 * 404. An address that MOVED to a refused handle is a person choosing it, so
 * its refusal is lifted (mutating `refused`) and it resolves as usual.
 */
function resolveAddress(
  workspaces: readonly WorkspaceSummary[],
  address: string,
  refused: Set<string>,
  moved: boolean,
): { wanted: WorkspaceSummary | null; refused: boolean; usable: WorkspaceSummary[] } {
  const resolved = resolveWorkspaceHandle(workspaces, address)
  if (moved && resolved !== null) refused.delete(workspaceHandle(resolved))
  const isRefused = resolved !== null && refused.has(workspaceHandle(resolved))
  return {
    wanted: isRefused ? null : resolved,
    refused: isRefused,
    usable: workspaces.filter((w) => !refused.has(workspaceHandle(w))),
  }
}

export function DaemonIndexPage({
  daemonBaseUrl,
  token,
  workspace,
  onWorkspaceResolved,
  onOpenDocument,
  serverMode = false,
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
  // The page's own reads go through the panel's source whenever they are
  // about the workspace on screen, so the two share one read. A load for any
  // other workspace (a stale callback) gets a source of its own.
  const filesSourceRef = useRef({ workspaceId: selectedWorkspace, source: filesSource })
  filesSourceRef.current = { workspaceId: selectedWorkspace, source: filesSource }
  const sourceFor = useCallback(
    (workspaceId: string) => {
      const current = filesSourceRef.current
      return current.workspaceId === workspaceId && current.source !== null
        ? current.source
        : createDaemonFilesSource(daemonFetch, daemonBaseUrl, workspaceId)
    },
    [daemonFetch, daemonBaseUrl],
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

  // Workspaces the LIST names but whose documents answered 404 — the list and
  // the routes disagree about them. The address is not allowed to resolve to
  // one: `reselectAfterStale` moves the page off it and stores a fresh list,
  // which re-runs the effect below while the address still names it, and
  // resolving it again selected it again — two workspaces alternating for as
  // long as the tab stayed open. An explicit retry, or choosing it again (see
  // `lastAddressRef`), still selects one, so a workspace that recovers is one
  // press away.
  const refusedRef = useRef(new Set<string>())
  // The address the effect below last saw. An address that MOVES to a refused
  // handle is a person choosing it — the switcher, a link — and is asked
  // again; the same address seen again because the list was re-read is not,
  // and neither is a move to the handle this page itself just reported.
  const lastAddressRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (workspace === undefined || !workspacesLoaded) return
    // A move this page caused by reporting its own selection is not a choice.
    const moved = lastAddressRef.current !== workspace && workspace !== reportedWorkspaceRef.current
    lastAddressRef.current = workspace
    const { wanted, refused, usable } = resolveAddress(
      workspaces,
      workspace,
      refusedRef.current,
      moved,
    )
    // A handle this list does not hold is EITHER a stale bookmark or a
    // workspace the switcher created or renamed a moment ago. The switcher is
    // the SHELL's and writes through its own source, so this page's list is a
    // snapshot taken before that write — and treating every miss as stale
    // meant creating a workspace landed on a DIFFERENT one and rewrote the
    // address to name it. So a miss re-reads the list once per handle; a
    // handle still missing after that is genuinely stale and gets the
    // first-listed fallback below, unchanged.
    if (wanted === null && !refused && refetchedForRef.current !== workspace) {
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
    const fallback = usable[0]
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
        // Every refused handle, not only this one: with two that 404, moving
        // from one to the other and back is the same loop one level down.
        const next = res.workspaces
          .map(workspaceHandle)
          .find((h) => h !== staleWorkspaceId && !refusedRef.current.has(h))
        if (next === undefined) {
          // Nothing to move to — this was the only workspace, or the list and
          // the documents disagree about it. Re-selecting the same one would
          // come straight back here forever, and leaving the page in its
          // loading state would spin without end. Say so instead: the request
          // that failed is the one the person is waiting on.
          setLoaded(true)
          setLoadError(WORKSPACE_GONE)
          // Nothing selected, so the recovery offered is Try again rather than
          // a create into a workspace the daemon does not have.
          setSelectedWorkspace(null)
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
        // Through the SAME source the panel reads, and as a refresh: this runs
        // on load and after every create, duplicate and delete, which is
        // exactly when the data moved. The panel's own read then answers from
        // what this one holds instead of asking again. The trash is read here
        // because the count decides whether onboarding may replace the panel.
        const { entries, trash } = await sourceFor(workspaceId).refresh()
        if (isStale()) return
        // Unordered on purpose: the panel orders what it shows from the same
        // source, and these rows serve lookups (a name, a path, a kind) only.
        setRows(
          entries.map((entry) => ({
            path: entry.path,
            displayName: entry.name ?? entry.path,
            updatedAt: entry.updatedAt,
            ...(entry.kind === undefined ? {} : { kind: entry.kind }),
          })),
        )
        setTrashCount(trash?.length ?? 0)
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
        if (err instanceof WorkspaceMissingError) {
          refusedRef.current.add(workspaceId)
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
    [sourceFor, reselectAfterStale],
  )

  // Re-read after a delete settled or its dialog was dismissed: after a
  // success the row must go, and after a FAILURE the daemon's state is
  // unknown from here — a 404 means the document was already gone (another
  // tab, an agent), and a stale row lingering after any failed delete is
  // worse than one refetch.
  const refreshAfterDelete = useCallback(() => {
    const workspaceAtStart = selectedWorkspace
    if (!workspaceAtStart) return
    const isStale = () => selectedWorkspaceRef.current !== workspaceAtStart
    void loadWorkspace(workspaceAtStart, isStale)
  }, [selectedWorkspace, loadWorkspace])

  const {
    requestDelete,
    reset: resetDelete,
    dialog: deleteDialog,
  } = useDeleteDocuments({
    keeper: 'daemon',
    deleteEach: (paths) => {
      // Read when Delete is PRESSED, not when the dialog opened — see the
      // reset in the workspace effect below.
      const workspaceAtStart = selectedWorkspace
      if (!workspaceAtStart) throw new Error('No workspace is selected.')
      return deleteEach(daemonFetch, daemonBaseUrl, workspaceAtStart, paths)
    },
    lookup: (path) => rows.find((row) => row.path === path),
    refresh: refreshAfterDelete,
    onDismiss: refreshAfterDelete,
  })

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
    // switch that the rows do not. The delete reads `selectedWorkspace`
    // when the button is pressed, not when the dialog opened, so confirming
    // after a switch sends the departed workspace's path to the one now on
    // screen. Measured before this line existed: opening Delete on ws-a's
    // `untitled`, switching to ws-b and confirming sent `DELETE ws-b/untitled`
    // — a document nobody selected.
    resetDelete()
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
        setCreateError(createFailureMessage(err, kind))
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
      // The whole operation targets workspaceAtStart, not whatever the user
      // has switched the selector to by the time each await resolves — a
      // duplicate started in one workspace must finish in that SAME
      // workspace even if the user has since switched away from it. Applying
      // its completion (the rows refresh) to the page is gated separately,
      // below, on whether that workspace is still the one being viewed.
      try {
        await duplicateDaemonDocument(
          duplicateRequest(daemonFetch, daemonBaseUrl, workspaceAtStart, sourcePath, rows),
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

        <DaemonIndexBody
          loadError={loadError}
          loaded={loaded}
          rows={rows}
          trashCount={trashCount}
          creating={creating}
          selectedWorkspace={selectedWorkspace}
          filesSource={filesSource}
          routedFolder={routedFolder}
          setRoutedFolder={setRoutedFolder}
          onOpenDocument={onOpenDocument}
          workspacesLoaded={workspacesLoaded}
          workspaceCount={workspaces.length}
          onCreate={handleCreate}
          onDuplicate={handleDuplicate}
          onRequestDelete={requestDelete}
          onRetryWorkspaces={loadWorkspaces}
          serverMode={serverMode}
        />
        <DeleteDocumentDialog {...deleteDialog} />
      </div>
    </DaemonApiContext.Provider>
  )
}
