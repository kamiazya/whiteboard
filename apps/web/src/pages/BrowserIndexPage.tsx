import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BrowserCapacityNotice } from '../components/BrowserCapacityNotice.js'
import { ExtensionConnectEntry } from '../components/connection/ExtensionConnectEntry.js'
import { DeleteDocumentsDialog } from '../components/document-list/DeleteDocumentsDialog.js'
import { DocumentsSkeleton } from '../components/document-list/DocumentsSkeleton.js'
import { EmptyWorkspaceState } from '../components/workspace-files/EmptyWorkspaceState.js'
import { WorkspaceFilesPanel } from '../components/workspace-files/WorkspaceFilesPanel.js'
import { useRoutedFolder } from '../hooks/useRoutedFolder.js'
import {
  type ContentClock,
  type DefaultDocumentPointer,
  ensureBrowserWorkspace,
  IdbDefaultDocumentPointer,
  idbContentClock,
  listBrowserDocuments,
} from '../lib/browser-document-summary.js'
import { createBrowserFilesSource } from '../lib/browser-files-source.js'
import { browserKeeperCapacity, type KeeperCapacity } from '../lib/browser-keeper-capacity.js'
import {
  browserWorkspaceIdentitySnapshot,
  browserWorkspaceIdOrNull,
  getBrowserWorkspaceId,
  leaveRemovedWorkspace,
  subscribeBrowserWorkspaceIdentity,
} from '../lib/browser-workspace-id.js'
import { createSeededDocument } from '../lib/create-seeded-document.js'
import { documentLabel } from '../lib/document-label.js'
import { duplicateBrowserDocument } from '../lib/duplicate-browser-document.js'
import { sharedFoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { followBrowserWorkspaceWrites } from '../lib/follow-workspace-writes.js'
import { kindNoun } from '../lib/kind-noun.js'
import { LoroStore } from '../lib/loro-store.js'
import { NEW_CANVAS_SHORTCUT } from '../lib/new-canvas-shortcut.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { workspaceHandle, workspaceLabel } from '../lib/workspace-handle.js'
import { isWorkspaceRemovedError } from '../lib/workspace-tombstone.js'
import { deleteRequestsFor, type PendingDelete } from './pending-delete.js'
import type { LoroStoreLike } from './use-browser-document-controller.js'
import { useDeleteDocuments } from './use-delete-documents.js'

export interface BrowserIndexPageProps {
  /** Defaults to the shared production index; injected by tests. */
  index?: DocumentIndex
  /** Seeds a content record for a newly created document; see handleCreate. */
  loro?: LoroStoreLike
  pointer?: DefaultDocumentPointer
  clock?: ContentClock
  onOpenDocument: (path: string) => void
  /**
   * Any value that changes when the route has RETURNED to this page without
   * remounting it. react-router v7 wraps navigations in startTransition, so
   * a Back issued while a lazy destination's chunk is still loading aborts
   * the transition and this page is never unmounted — its load effect does
   * not re-run, and the list shows the state from before the navigation
   * (measured: onboarding create → immediate Back rendered onboarding again
   * over a workspace holding the document). App passes the LOCATION OBJECT —
   * not `location.key`, which is per-history-entry and comes back UNCHANGED
   * from a Back (measured: keyed on it, the stale list survived).
   */
  revision?: unknown
  /** The keeper's declared capacity; the device's own unless a test injects one. */
  capacity?: KeeperCapacity
}

// The browser keeper's landing surface: the same three-pane document browser
// the daemon page renders, minus its daemon-only capabilities (no workspace
// selector). The page keeps its own snapshot list only to know which of the
// loading / onboarding / panel states to show; the panel reads the store
// through its own source.
// Module-level, NOT default parameters. A default in the parameter list is
// evaluated on every render, so `idbContentClock()` hands back a new function
// identity each time; the load effect depends on it, `setSnapshots` stores a
// new array, the render mints another clock, and the effect runs again without
// end. Measured on the production wiring (index + onOpenDocument only): 464
// index reads and still climbing after half a second.
const defaultLoroStore = /* @__PURE__ */ new LoroStore()
const defaultPointer: DefaultDocumentPointer = /* @__PURE__ */ new IdbDefaultDocumentPointer()
const defaultClock: ContentClock = /* @__PURE__ */ idbContentClock()

/**
 * Delete each path, recording rather than throwing on the ones that will not
 * go.
 *
 * Sequential and failure-tolerant on purpose: one path that cannot be deleted
 * must not abandon the rest, and the person has to be told how many did not
 * go. The POINTER is resolved by the caller before any of this, because
 * afterwards there is nothing left to compare it against, and a pointer
 * still naming a deleted document is cleared rather than left for the
 * editor's next open to fall past.
 */
async function deleteEach(
  index: DocumentIndex,
  pointer: DefaultDocumentPointer,
  paths: readonly string[],
  pointed: string | null,
): Promise<{ failed: string[]; lastError: null }> {
  const failed: string[] = []
  const workspaceId = getBrowserWorkspaceId()
  for (const path of paths) {
    try {
      const target = await index.resolveDocument({ workspaceId, path })
      await index.deleteDocument({ workspaceId, path })
      if (pointed !== null && target !== null && pointed === target.documentId) {
        await pointer.clear()
      }
    } catch {
      failed.push(path)
    }
  }
  // `lastError: null` on purpose: what the index threw is not a sentence
  // for a person, so the dialog reports this keeper's own fallback.
  return { failed, lastError: null }
}

/**
 * The workspace's own display NAME. Its own chain, deliberately not folded
 * into the documents load: a name that will not load leaves the heading on
 * the handle, which is still true, and must not surface as "Failed to load
 * documents from this browser."
 */
function useBrowserWorkspaceName(
  index: BrowserIndexPageProps['index'] & {},
  activeWorkspace: ReturnType<typeof browserWorkspaceIdentitySnapshot>,
  revision: BrowserIndexPageProps['revision'],
): string | null {
  const [workspaceName, setWorkspaceName] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    // Cleared BEFORE the lookup, not merely overwritten after it. On a switch
    // this state still holds the workspace the person just left, and the
    // `.catch` below deliberately swallows a failed read — so without this the
    // new workspace renders under the old one's name, indefinitely and with
    // nothing saying so. Dropping to the handle fallback for the round trip is
    // the right trade: the handle is what the address already carries, and it
    // is true about the workspace on screen.
    setWorkspaceName(null)
    Promise.resolve()
      .then(() => index.resolveWorkspace(getBrowserWorkspaceId()))
      .then((row) => {
        if (!cancelled) setWorkspaceName(row === null ? null : workspaceLabel(row))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [index, activeWorkspace, revision])
  return workspaceName
}

/** The subscribed workspace identity, and the files source scoped to it. */
function useBrowserFilesSource(
  index: BrowserIndexPageProps['index'] & {},
  loro: BrowserIndexPageProps['loro'] & {},
  clock: BrowserIndexPageProps['clock'] & {},
) {
  // The workspace this page is listing. Subscribed, not read: ADR-0019's
  // switch is an in-SPA route change, so this page stays mounted across one,
  // and the load effect below keyed on the index and the clock — neither of
  // which moves when the workspace does. It kept showing the documents of the
  // workspace the person had just left, under an address naming the one they
  // went to.
  const activeWorkspace = useSyncExternalStore(
    subscribeBrowserWorkspaceIdentity,
    browserWorkspaceIdentitySnapshot,
  )
  // The panel reads through the SAME stores this page was given — never a
  // second instance that merely happens to open the same database.
  //
  // Keyed on the ACTIVE WORKSPACE as well, because the panel detects a switch
  // by this identity changing — the same contract the daemon page's source
  // memo keeps with `selectedWorkspace`. Without it the panel never learned a
  // switch had happened: its cards, selection, open folder and search results
  // all still belonged to the workspace the person had left, while the page's
  // own heading and onboarding decision had already followed. Worse than
  // stale: paths collide across workspaces (`untitled` most of all) and the
  // card menu's Delete carries a PATH, which this page then resolves against
  // whichever workspace is active NOW.
  const filesSource = useMemo(
    () => createBrowserFilesSource({ index, loro, clock }),
    // `activeWorkspace` is not read by the factory — the source reads the
    // accessor at call time. It is here as the switch SIGNAL the panel keys
    // on, which is the whole point of the memo.
    [index, loro, clock, activeWorkspace],
  )
  return { activeWorkspace, filesSource }
}

/** The documents and the trash count, re-read on every trigger that moves them. */
interface BrowserDocumentsLoadInput {
  index: BrowserIndexPageProps['index'] & {}
  clock: BrowserIndexPageProps['clock'] & {}
  filesSource: ReturnType<typeof createBrowserFilesSource>
  activeWorkspace: ReturnType<typeof browserWorkspaceIdentitySnapshot>
  revision: BrowserIndexPageProps['revision']
  filesRevision: number
  setSnapshots: (rows: DocumentSnapshot[]) => void
  setTrashCount: (count: number) => void
  setError: (message: string | null) => void
  /** The workspace being listed left this browser; see `useLeaveRemovedWorkspace`. */
  onRemoved: (workspaceId: string) => void
}

/**
 * Not a storage failure when the workspace moved off this browser in a tab
 * whose message this one missed: the list moves too.
 */
function loadFailed(err: unknown, listed: string | undefined, props: BrowserDocumentsLoadInput) {
  if (isWorkspaceRemovedError(err) && listed !== undefined) props.onRemoved(listed)
  else props.setError('Failed to load documents from this browser.')
}

function useBrowserDocumentsLoad(props: BrowserDocumentsLoadInput): void {
  useEffect(() => {
    let cancelled = false
    // Cleared on every re-load, not only set on failure: this effect now
    // re-runs on ordinary Backs (`revision`), so a transient failure's alert
    // would otherwise outlive the successful retry indefinitely (measured:
    // fail-once-then-succeed left the alert over a correct list).
    props.setError(null)
    // On a device that has never created a document there is no workspace to
    // list, and the port answers that with an error rather than an empty
    // list. Ensuring it here is what makes a first visit render the empty
    // state instead of "Failed to load documents from this browser."
    const listed = props.activeWorkspace?.workspaceId
    ensureBrowserWorkspace(props.index)
      .then(() => listBrowserDocuments(props.index, props.clock))
      .then((all) => {
        if (!cancelled) props.setSnapshots(all)
      })
      .catch((err: unknown) => {
        if (!cancelled) loadFailed(err, listed, props)
      })
    props.filesSource
      .listTrash?.()
      .then((rows) => {
        if (!cancelled) props.setTrashCount(rows.length)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // `activeWorkspace` is what this effect follows: the list helpers read
    // the accessor themselves, so depending on the value is the difference
    // between a list that re-reads on a switch and one that does not. The
    // body reads it only to name the workspace a refusal is about, for the
    // removed-workspace routing in `loadFailed`. Two more triggers for the
    // same aborted-startTransition mount (a Back while a lazy chunk loads
    // returns to THIS mount, never remounting): `filesRevision` follows this
    // page's OWN writes (create below, delete dialog), and
    // `revision` follows the ROUTE returning here (see the prop's doc) so a
    // return re-reads even when the write was not this page's own.
  }, [
    props.index,
    props.clock,
    props.filesSource,
    props.activeWorkspace,
    props.revision,
    props.filesRevision,
  ])
}

/**
 * Every other tab writes to this record too, and a mount that only followed
 * its own writes never listed another tab's create or rename. Bumps the same
 * revision this page's own writes do, so the panel re-reads with the list.
 */
function useFollowOtherTabs(
  workspaceId: string | null,
  setFilesRevision: (next: (revision: number) => number) => void,
  onRemoved: (workspaceId: string) => void,
): void {
  useEffect(() => {
    if (workspaceId === null) return
    return followBrowserWorkspaceWrites(workspaceId, {
      onMoved: () => setFilesRevision((n) => n + 1),
      onRemoved: () => onRemoved(workspaceId),
    })
  }, [workspaceId, setFilesRevision, onRemoved])
}

/**
 * The workspace this list shows moved to a daemon from another tab. That tab
 * re-points itself; this one moves to a workspace the browser still keeps
 * (the identity change re-reads the list) and says why it did, instead of
 * reporting the registry's refusal as storage that failed.
 */
function useLeaveRemovedWorkspace(activeId: string | null) {
  // The notice belongs to the workspace this tab landed on: it stays while
  // that one is shown and goes once the person switches anywhere else.
  const [left, setLeft] = useState<{ removed: string; landedOn: string | null } | null>(null)
  const onRemoved = useCallback((workspaceId: string) => {
    setLeft({ removed: workspaceId, landedOn: null })
    // A registry that will not read leaves the list where it is, and its
    // next load says so through the ordinary failure.
    leaveRemovedWorkspace(workspaceId).catch(() => undefined)
  }, [])
  useEffect(() => {
    if (left === null || activeId === null || activeId === left.removed) return
    if (left.landedOn === null) setLeft({ ...left, landedOn: activeId })
    else if (left.landedOn !== activeId) setLeft(null)
  }, [left, activeId])
  return { moved: left !== null, onRemoved }
}

interface BrowserIndexListingInput {
  index: BrowserIndexPageProps['index'] & {}
  loro: BrowserIndexPageProps['loro'] & {}
  clock: BrowserIndexPageProps['clock'] & {}
  revision: BrowserIndexPageProps['revision']
}

/**
 * What this page LISTS, and the reads that keep it current: the documents,
 * the trash count the onboarding decision consults, the workspace's own name,
 * and the files source the panel reads through. Held together because they
 * re-read together — on a workspace switch, on this page's own writes, on
 * another tab's, and on a Back that returns to this mount.
 */
function useBrowserIndexListing(props: BrowserIndexListingInput) {
  const [snapshots, setSnapshots] = useState<DocumentSnapshot[] | null>(null)
  // Consulted only for the onboarding decision below: a workspace whose list
  // is empty but whose trash is not must keep the PANEL, because the Trash
  // section is the one affordance that undoes the delete that just emptied
  // the list. Failure degrades to 0 — onboarding — never to an error.
  const [trashCount, setTrashCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const { activeWorkspace, filesSource } = useBrowserFilesSource(
    props.index,
    props.loro,
    props.clock,
  )
  // Deletions happen in this page's dialog, behind the panel's back — the
  // panel re-reads whenever this identity changes, exactly as on the daemon
  // page.
  const [filesRevision, setFilesRevision] = useState(0)
  const leave = useLeaveRemovedWorkspace(activeWorkspace?.workspaceId ?? null)
  useFollowOtherTabs(activeWorkspace?.workspaceId ?? null, setFilesRevision, leave.onRemoved)

  useBrowserDocumentsLoad({
    index: props.index,
    clock: props.clock,
    filesSource,
    activeWorkspace,
    revision: props.revision,
    filesRevision,
    setSnapshots,
    setTrashCount,
    setError,
    onRemoved: leave.onRemoved,
  })

  const workspaceName = useBrowserWorkspaceName(props.index, activeWorkspace, props.revision)

  return {
    snapshots,
    setSnapshots,
    trashCount,
    setTrashCount,
    error,
    setError,
    workspaceName,
    filesSource,
    filesRevision,
    setFilesRevision,
    activeWorkspace,
    ...leave,
  }
}

/**
 * The four states this list can be in, in the order they are decided:
 * loading, onboarding (empty with nothing in the trash), the panel, and a
 * failed load. A component rather than a ternary chain in the page body —
 * each arm is a different screen, and reading which one is on is what the
 * chain made hard.
 */
interface BrowserIndexBodyProps {
  snapshots: DocumentSnapshot[] | null
  trashCount: number
  error: string | null
  creating: boolean
  filesSource: ReturnType<typeof createBrowserFilesSource>
  activeWorkspace: ReturnType<typeof browserWorkspaceIdentitySnapshot>
  routedFolder: ReturnType<typeof useRoutedFolder>['folder']
  setRoutedFolder: ReturnType<typeof useRoutedFolder>['setFolder']
  onOpenDocument: BrowserIndexPageProps['onOpenDocument']
  filesRevision: number
  onCreate: (kind: DocumentKind) => void | Promise<void>
  onDuplicate: (path: string) => void | Promise<void>
  onRequestDelete: (pending: PendingDelete) => void
  capacity: KeeperCapacity
}

function BrowserIndexBody(props: BrowserIndexBodyProps) {
  if (props.snapshots === null && !props.error) return <DocumentsSkeleton />
  if (props.snapshots !== null && props.snapshots.length === 0 && props.trashCount === 0) {
    // The onboarding state renders INSTEAD of the panel: a three-pane browser
    // of nothing teaches less than one sentence and one button, and this
    // button also OPENS what it creates.
    return (
      <EmptyWorkspaceState
        onCreate={(kind) => void props.onCreate(kind)}
        disabled={props.creating}
        subtitle="Everything stays in this browser — no account, no upload."
        footer={
          <ExtensionConnectEntry lead="Or keep your documents on the whiteboard daemon on this computer, where AI agents can reach them." />
        }
      />
    )
  }
  if (props.snapshots !== null) {
    return <BrowserFilesSection {...props} />
  }
  // Load failed (error set, snapshots never arrived): creating does not need
  // the list — numbering falls back to nothing and the index refuses a
  // duplicate address, so the worst case is a refused create rather than two
  // documents at one path.
  return (
    <button
      type="button"
      disabled={props.creating}
      onClick={() => void props.onCreate('spatial')}
      className="self-start rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
    >
      Create a canvas
    </button>
  )
}

/** The panel itself, once the list has arrived. */
function BrowserFilesSection(props: BrowserIndexBodyProps) {
  return (
    <>
      <BrowserCapacityNotice
        documentCount={props.snapshots?.length ?? 0}
        capacity={props.capacity}
      />
      <BrowserFilesPanel {...props} />
    </>
  )
}

function BrowserFilesPanel(props: BrowserIndexBodyProps) {
  return (
    <WorkspaceFilesPanel
      source={props.filesSource}
      // Read from the subscribed identity rather than the address: this
      // page stays mounted across an in-SPA workspace switch, and the
      // identity is what moves with it.
      workspace={
        props.activeWorkspace === null ? undefined : workspaceHandle(props.activeWorkspace)
      }
      initialFolder={props.routedFolder}
      onFolderChange={props.setRoutedFolder}
      onOpenDocument={props.onOpenDocument}
      // Duplicating does NOT open the copy, matching the daemon row: the
      // person is working in the list, and the copy appears there.
      onDuplicateDocument={(path) => void props.onDuplicate(path)}
      {...deleteRequestsFor(props.onRequestDelete)}
      revision={props.filesRevision}
    />
  )
}

/** Said where the list is: why it now shows another workspace than the one it did. */
function WorkspaceMovedNotice() {
  return (
    <p
      role="status"
      data-testid="workspace-moved-notice"
      className="mb-2 text-sm text-muted-foreground"
    >
      The workspace this tab was showing moved to the daemon, so this browser no longer keeps it.
    </p>
  )
}

interface BrowserCreateInput {
  index: NonNullable<BrowserIndexPageProps['index']>
  loro: NonNullable<BrowserIndexPageProps['loro']>
  clock: NonNullable<BrowserIndexPageProps['clock']>
  pointer: NonNullable<BrowserIndexPageProps['pointer']>
  onOpenDocument: BrowserIndexPageProps['onOpenDocument']
  setFilesRevision: (next: (revision: number) => number) => void
  setError: (message: string | null) => void
  onRemoved: (workspaceId: string) => void
}

/** This page's create: a seeded document, opened, or a refusal said in place. */
function useBrowserCreate({
  index,
  loro,
  clock,
  pointer,
  onOpenDocument,
  setFilesRevision,
  setError,
  onRemoved,
}: BrowserCreateInput) {
  // The `disabled` attribute (via createDisabled) is the whole double-press
  // mechanism: React flushes this state before a second click can dispatch,
  // and a handler-side `if (creating) return` reads a stale closure in
  // exactly the same-tick case it would have to catch.
  const [creating, setCreating] = useState(false)
  const handleCreate = useCallback(
    async (kind: DocumentKind) => {
      setCreating(true)
      const target = browserWorkspaceIdOrNull()
      try {
        // Numbered against the INDEX, not against `snapshots`: the list is
        // not among this callback's dependencies, so a rendered list captured
        // here would be whatever the render that memoized it held — `null` on
        // the first create after a load, which numbers from nothing and lands
        // on a path already taken. A failed read falls back to numbering from
        // nothing, which the index's own uniqueness check then refuses rather
        // than duplicating an address.
        // The editor's create path, not a second one beside it: numbering,
        // the content seed, and the rollback on a failed seed are all things
        // a second create path would do differently or not at all.
        const created = await createSeededDocument(index, loro, clock, undefined, kind)
        // Repointed so a later plain load resumes in the new document — the
        // same contract the editor's own create/switch flows keep.
        await pointer.set(created.documentId)
        // This page's own list must see the create even if it never
        // unmounts (Back before the editor chunk mounts) — see the load
        // effect's dependency note.
        setFilesRevision((n) => n + 1)
        onOpenDocument(created.path)
      } catch (err) {
        if (isWorkspaceRemovedError(err) && target !== null) onRemoved(target)
        else setError(`Failed to create a ${kindNoun(kind)} in this browser.`)
      } finally {
        setCreating(false)
      }
    },
    [index, loro, clock, pointer, onOpenDocument, setFilesRevision, setError, onRemoved],
  )
  return { creating, handleCreate }
}

/**
 * The installed app's "New canvas" launcher shortcut (the manifest's
 * `shortcuts`, declared in `lib/new-canvas-shortcut.ts`): one create through
 * this page's own create path, which opens what it made. The parameter leaves the address first, by
 * REPLACING the entry, so neither a reload nor a Back into it creates a
 * second document.
 */
function useLauncherShortcut(onCreate: (kind: DocumentKind) => Promise<void>): void {
  const [params, setParams] = useSearchParams()
  const handled = useRef(false)
  useEffect(() => {
    // Re-armed once the parameter is gone, so a later visit retries a create
    // that failed; held while it is present, so one visit creates once.
    if (!NEW_CANVAS_SHORTCUT.isRequestedBy(params)) {
      handled.current = false
      return
    }
    if (handled.current) return
    handled.current = true
    setParams(NEW_CANVAS_SHORTCUT.removedFrom, { replace: true })
    void onCreate('spatial')
  }, [params, setParams, onCreate])
}

export function BrowserIndexPage({
  // Safe as a parameter default (unlike the clocks below): the shared
  // accessor memoizes, so every render sees the same identity. The concrete
  // index lives behind this lazy page, not in App, to keep loro-crdt off the
  // entry chunk (entry-graph-loro-free.test.ts).
  index = sharedFoldingBrowserIndex(),
  loro = defaultLoroStore,
  pointer = defaultPointer,
  clock = defaultClock,
  onOpenDocument,
  revision,
  capacity = browserKeeperCapacity(),
}: BrowserIndexPageProps) {
  const {
    snapshots,
    setSnapshots,
    trashCount,
    setTrashCount,
    error,
    setError,
    workspaceName,
    filesSource,
    filesRevision,
    setFilesRevision,
    activeWorkspace,
    moved,
    onRemoved,
  } = useBrowserIndexListing({ index, loro, clock, revision })
  // Re-read after a delete settled, with the dialog still open after a
  // partial failure: the ones that went are gone, and a list still showing
  // them behind the dialog contradicts the count above it.
  const refreshAfterDelete = useCallback(async () => {
    setSnapshots(await listBrowserDocuments(index, clock))
    // The delete just moved a document INTO the trash — re-count so the
    // onboarding decision below sees it before choosing what to render.
    const trashRows = await filesSource.listTrash?.().catch(() => null)
    if (trashRows != null) setTrashCount(trashRows.length)
    // The tree view holds its own copy of the list; this identity change is
    // its signal to re-read, same contract as the daemon page's `revision`.
    setFilesRevision((revision) => revision + 1)
  }, [index, clock, filesSource, setSnapshots, setTrashCount, setFilesRevision])

  // The index deletes by PATH, and the list already addresses rows that way,
  // so the request carries the path.
  const { requestDelete, dialog: deleteDialog } = useDeleteDocuments({
    keeper: 'browser',
    // The pointer is resolved BEFORE the delete, because afterwards there is
    // nothing left to compare it against.
    deleteEach: async (paths) => deleteEach(index, pointer, paths, await pointer.get()),
    lookup: (path) => {
      const row = snapshots?.find((snapshot) => snapshot.path === path)
      return row && { displayName: documentLabel(row, 'path'), kind: row.kind }
    },
    refresh: refreshAfterDelete,
  })

  const { folder: routedFolder, setFolder: setRoutedFolder } = useRoutedFolder()

  // One at a time, for the reason the daemon row gives: two duplicates of the
  // same source race on the name the copy is given.
  const [duplicating, setDuplicating] = useState(false)
  const handleDuplicate = useCallback(
    async (sourcePath: string) => {
      if (duplicating) return
      setDuplicating(true)
      setError(null)
      try {
        await duplicateBrowserDocument({ index, clock, sourcePath })
        // ONLY the duplicate itself is under this catch. The bump is what
        // re-reads the list (the load effect follows it) and that effect owns
        // its own refusal — so a re-read that fails after the copy exists is
        // reported as a list that could not be read, never as a duplicate
        // that did not happen. The wrong answer there invites a second press,
        // and the second copy is real too.
        setFilesRevision((n) => n + 1)
      } catch {
        setError('Failed to duplicate the document in this browser.')
      } finally {
        setDuplicating(false)
      }
    },
    [index, loro, clock, duplicating, setError, setFilesRevision],
  )

  const { creating, handleCreate } = useBrowserCreate({
    index,
    loro,
    clock,
    pointer,
    onOpenDocument,
    setFilesRevision,
    setError,
    onRemoved,
  })
  useLauncherShortcut(handleCreate)

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      {/* The generic word moved to the panel's own region label. Before the
          row lands the segment is what the address carries, and the last
          fallback keeps the page from ever having no h1 at all. */}
      <h1 className="mb-3 truncate text-lg font-semibold">
        {workspaceName ?? activeWorkspace?.segment ?? 'Documents'}
      </h1>
      {moved && <WorkspaceMovedNotice />}
      {error && (
        <div role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <BrowserIndexBody
        snapshots={snapshots}
        trashCount={trashCount}
        error={error}
        creating={creating}
        filesSource={filesSource}
        activeWorkspace={activeWorkspace}
        routedFolder={routedFolder}
        setRoutedFolder={setRoutedFolder}
        onOpenDocument={onOpenDocument}
        filesRevision={filesRevision}
        onCreate={handleCreate}
        onDuplicate={handleDuplicate}
        onRequestDelete={requestDelete}
        capacity={capacity}
      />
      <DeleteDocumentsDialog {...deleteDialog} />
    </div>
  )
}
