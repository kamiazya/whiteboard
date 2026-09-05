import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { DeleteDocumentDialog } from '../components/document-list/DeleteDocumentDialog.js'
import { EmptyWorkspaceState } from '../components/workspace-files/EmptyWorkspaceState.js'
import { WorkspaceFilesPanel } from '../components/workspace-files/WorkspaceFilesPanel.js'
import { useRoutedFolder } from '../hooks/useRoutedFolder.js'
import {
  browserWorkspaceIdentitySnapshot,
  getBrowserWorkspaceId,
  subscribeBrowserWorkspaceIdentity,
} from '../lib/browser-workspace-id.js'
import { sharedFoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { kindNoun } from '../lib/kind-noun.js'
import {
  type ContentClock,
  type DefaultDocumentPointer,
  ensureLocalWorkspace,
  IdbDefaultDocumentPointer,
  idbContentClock,
  listLocalDocuments,
} from '../lib/local-document-summary.js'
import { createLocalFilesSource } from '../lib/local-files-source.js'
import { LoroStore } from '../lib/loro-store.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { workspaceHandle, workspaceLabel } from '../lib/workspace-handle.js'
import { createSeededDocument, type LoroStoreLike } from './use-browser-document-controller.js'

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
}: BrowserIndexPageProps) {
  const [snapshots, setSnapshots] = useState<DocumentSnapshot[] | null>(null)
  // Consulted only for the onboarding decision below: a workspace whose list
  // is empty but whose trash is not must keep the PANEL, because the Trash
  // section is the one affordance that undoes the delete that just emptied
  // the list. Failure degrades to 0 — onboarding — never to an error.
  const [trashCount, setTrashCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // The `disabled` attribute (via createDisabled) is the whole double-press
  // mechanism: React flushes this state before a second click can dispatch,
  // and a handler-side `if (creating) return` reads a stale closure in
  // exactly the same-tick case it would have to catch.
  const [creating, setCreating] = useState(false)
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
    () => createLocalFilesSource({ index, loro, clock }),
    // `activeWorkspace` is not read by the factory — the source reads the
    // accessor at call time. It is here as the switch SIGNAL the panel keys
    // on, which is the whole point of the memo.
    [index, loro, clock, activeWorkspace],
  )
  // Deletions happen in this page's dialog, behind the panel's back — the
  // panel re-reads whenever this identity changes, exactly as on the daemon
  // page.
  const [filesRevision, setFilesRevision] = useState(0)
  // What this page calls itself. The identity the accessor publishes carries
  // no display name (it is the ADDRESSING half), so the row has to be read —
  // in the same effect, which already re-runs on a switch.
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
    // Cleared on every re-load, not only set on failure: this effect now
    // re-runs on ordinary Backs (`revision`), so a transient failure's alert
    // would otherwise outlive the successful retry indefinitely (measured:
    // fail-once-then-succeed left the alert over a correct list).
    setError(null)
    // Its own chain, deliberately not folded into the documents load below: a
    // name that will not load leaves the heading on the handle, which is still
    // true, and must not surface as "Failed to load documents from this
    // browser."
    Promise.resolve()
      .then(() => index.resolveWorkspace(getBrowserWorkspaceId()))
      .then((row) => {
        if (!cancelled) setWorkspaceName(row === null ? null : workspaceLabel(row))
      })
      .catch(() => undefined)
    // On a device that has never created a document there is no workspace to
    // list, and the port answers that with an error rather than an empty
    // list. Ensuring it here is what makes a first visit render the empty
    // state instead of "Failed to load documents from this browser."
    ensureLocalWorkspace(index)
      .then(() => listLocalDocuments(index, clock))
      .then((all) => {
        if (!cancelled) setSnapshots(all)
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load documents from this browser.')
      })
    filesSource
      .listTrash?.()
      .then((rows) => {
        if (!cancelled) setTrashCount(rows.length)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
    // `activeWorkspace` is not read in the body — the helpers below read the
    // accessor themselves — but it IS what this effect follows. Depending on
    // the value rather than calling it is the difference between a list that
    // re-reads on a switch and one that does not. Two more triggers for the
    // same aborted-startTransition mount (a Back while a lazy chunk loads
    // returns to THIS mount, never remounting): `filesRevision` follows this
    // page's OWN writes (create below, delete dialog — #1325's fix), and
    // `revision` follows the ROUTE returning here (see the prop's doc) so a
    // return re-reads even when the write was not this page's own.
  }, [index, clock, filesSource, activeWorkspace, revision, filesRevision])

  // The index deletes by PATH, and the list already addresses rows that way,
  // so this carries the path rather than the id it used to need.
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

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    setDeleting(true)
    setDeleteError(null)
    try {
      // Resolved BEFORE the delete, because afterwards there is nothing left
      // to compare the pointer against. A pointer still naming the deleted
      // document does not degrade gracefully: the editor's resume path
      // reports 'The canvas data could not be read.', so an ordinary delete
      // would hand the user an error screen the next time they open the
      // editor.
      const pointed = await pointer.get()
      // Sequential, and each failure recorded rather than thrown: one path
      // that cannot be deleted must not abandon the rest, and the person has
      // to be told how many did not go.
      const failed: string[] = []
      for (const path of pendingDelete.paths) {
        try {
          const target = await index.resolveDocument({
            workspaceId: getBrowserWorkspaceId(),
            path,
          })
          await index.deleteDocument({ workspaceId: getBrowserWorkspaceId(), path })
          if (pointed !== null && target !== null && pointed === target.documentId) {
            await pointer.clear()
          }
        } catch {
          failed.push(path)
        }
      }
      setSnapshots(await listLocalDocuments(index, clock))
      // The delete just moved a document INTO the trash — re-count so the
      // onboarding decision below sees it before choosing what to render.
      const trashRows = await filesSource.listTrash?.().catch(() => null)
      if (trashRows != null) setTrashCount(trashRows.length)
      // The tree view holds its own copy of the list; this identity change is
      // its signal to re-read, same contract as the daemon page's `revision`.
      setFilesRevision((revision) => revision + 1)
      if (failed.length > 0) {
        const attempted = pendingDelete.paths.length
        // Held open on the count, because the list behind it has already
        // changed (refreshed above): the ones that went are gone, and closing
        // silently would read as "all deleted". The panel's own pruning
        // leaves exactly the failures selected.
        //
        // Narrowed to what failed, so pressing Delete again retries exactly
        // those. This browser index no-ops a delete for an absent row, so a
        // re-send would be harmless here — but the daemon page answers 404
        // and its retry genuinely diverged, and one operation should not
        // converge differently per keeper.
        const only = failed.length === 1 ? snapshots?.find((s) => s.path === failed[0]) : undefined
        setPendingDelete({
          paths: failed,
          // A lone survivor gets its NAME back: `Delete "2 documents"?` would
          // be the count of the attempt, not of what it now offers to do.
          displayName: only?.name ?? (failed[0] as string),
          ...(only?.kind === undefined ? {} : { kind: only.kind }),
        })
        setDeleteError(
          failed.length === attempted
            ? 'Failed to delete the document from this browser.'
            : `${failed.length} of ${attempted} could not be deleted.`,
        )
        return
      }
      setPendingDelete(null)
    } catch {
      setDeleteError('Failed to delete the document from this browser.')
    } finally {
      setDeleting(false)
    }
  }, [index, clock, pointer, pendingDelete, filesSource])

  const { folder: routedFolder, setFolder: setRoutedFolder } = useRoutedFolder()

  const handleCreate = useCallback(
    async (kind: DocumentKind) => {
      setCreating(true)
      try {
        // Numbered against the INDEX, not against `snapshots`: this callback
        // is memoized on [index, onOpenDocument], so a rendered list captured
        // here would be whatever the first render held — `null` on the first
        // create after a load, which numbers from nothing and lands on a path
        // already taken. A failed read falls back to numbering from nothing,
        // which the index's own uniqueness check then refuses rather than
        // duplicating an address.
        // The editor's create path, not a second one beside it: numbering,
        // the content seed, and the rollback on a failed seed are all things
        // this page used to do differently or not at all.
        const created = await createSeededDocument(index, loro, clock, undefined, kind)
        // Repointed so a later plain load resumes in the new document — the
        // same contract the editor's own create/switch flows keep.
        await pointer.set(created.documentId)
        // This page's own list must see the create even if it never
        // unmounts (Back before the editor chunk mounts) — see the load
        // effect's dependency note.
        setFilesRevision((n) => n + 1)
        onOpenDocument(created.path)
      } catch {
        setError(`Failed to create a ${kindNoun(kind)} in this browser.`)
      } finally {
        setCreating(false)
      }
    },
    [index, loro, clock, pointer, onOpenDocument],
  )

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      {/* The generic word moved to the panel's own region label. Before the
          row lands the segment is what the address carries, and the last
          fallback keeps the page from ever having no h1 at all. */}
      <h1 className="mb-3 truncate text-lg font-semibold">
        {workspaceName ?? activeWorkspace?.segment ?? 'Documents'}
      </h1>
      {error && (
        <div role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {snapshots === null && !error ? (
        <div
          role="status"
          aria-label="Loading documents"
          className="skeleton-appear grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
        >
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse rounded-lg border p-2">
              <div className="mt-2 h-4 w-2/3 rounded bg-muted" />
            </div>
          ))}
        </div>
      ) : snapshots !== null && snapshots.length === 0 && trashCount === 0 ? (
        // The onboarding state renders INSTEAD of the panel: a three-pane
        // browser of nothing teaches less than one sentence and one button,
        // and this button also OPENS what it creates.
        <EmptyWorkspaceState
          onCreate={(kind) => void handleCreate(kind)}
          disabled={creating}
          subtitle="Everything stays in this browser — no account, no upload."
        />
      ) : snapshots !== null ? (
        <WorkspaceFilesPanel
          source={filesSource}
          // Read from the subscribed identity rather than the address: this
          // page stays mounted across an in-SPA workspace switch, and the
          // identity is what moves with it.
          workspace={activeWorkspace === null ? undefined : workspaceHandle(activeWorkspace)}
          initialFolder={routedFolder}
          onFolderChange={setRoutedFolder}
          onOpenDocument={onOpenDocument}
          onRequestDelete={(path, displayName, kind) =>
            setPendingDelete({ paths: [path], displayName, kind })
          }
          onRequestDeleteMany={(paths) =>
            setPendingDelete({ paths, displayName: `${paths.length} documents` })
          }
          revision={filesRevision}
        />
      ) : (
        // Load failed (error set, snapshots never arrived): creating does
        // not need the list — numbering falls back to nothing and the index
        // refuses a duplicate address, so the worst case is a refused create
        // rather than two documents at one path.
        <button
          type="button"
          disabled={creating}
          onClick={() => void handleCreate('spatial')}
          className="self-start rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
        >
          Create a canvas
        </button>
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
            ? 'delete-documents-browser'
            : 'delete-document-browser'
        }
        onCancel={() => {
          setPendingDelete(null)
          setDeleteError(null)
        }}
        onConfirm={() => void handleConfirmDelete()}
      />
    </div>
  )
}
