import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DeleteDocumentDialog } from '../components/document-list/DeleteDocumentDialog.js'
import { EmptyWorkspaceState } from '../components/workspace-files/EmptyWorkspaceState.js'
import { WorkspaceFilesPanel } from '../components/workspace-files/WorkspaceFilesPanel.js'
import { useRoutedFolder } from '../hooks/useRoutedFolder.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
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
import { createSeededDocument, type LoroStoreLike } from './use-browser-document-controller.js'

export interface BrowserIndexPageProps {
  /** Defaults to the shared production index; injected by tests. */
  index?: DocumentIndex
  /** Seeds a content record for a newly created document; see handleCreate. */
  loro?: LoroStoreLike
  pointer?: DefaultDocumentPointer
  clock?: ContentClock
  onOpenDocument: (path: string) => void
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
  // The panel reads through the SAME stores this page was given — never a
  // second instance that merely happens to open the same database.
  const filesSource = useMemo(
    () => createLocalFilesSource({ index, loro, clock }),
    [index, loro, clock],
  )
  // Deletions happen in this page's dialog, behind the panel's back — the
  // panel re-reads whenever this identity changes, exactly as on the daemon
  // page.
  const [filesRevision, setFilesRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
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
  }, [index, clock, filesSource])

  // The index deletes by PATH, and the list already addresses rows that way,
  // so this carries the path rather than the id it used to need.
  const [pendingDelete, setPendingDelete] = useState<{
    path: string
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
      const target = await index.resolveDocument({
        workspaceId: getBrowserWorkspaceId(),
        path: pendingDelete.path,
      })
      await index.deleteDocument({ workspaceId: getBrowserWorkspaceId(), path: pendingDelete.path })
      if (pointed !== null && target !== null && pointed === target.documentId) {
        await pointer.clear()
      }
      setSnapshots(await listLocalDocuments(index, clock))
      // The delete just moved a document INTO the trash — re-count so the
      // onboarding decision below sees it before choosing what to render.
      const trashRows = await filesSource.listTrash?.().catch(() => null)
      if (trashRows != null) setTrashCount(trashRows.length)
      // The tree view holds its own copy of the list; this identity change is
      // its signal to re-read, same contract as the daemon page's `revision`.
      setFilesRevision((revision) => revision + 1)
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
      <h1 className="sr-only">Documents</h1>
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
          initialFolder={routedFolder}
          onFolderChange={setRoutedFolder}
          onOpenDocument={onOpenDocument}
          onRequestDelete={(path, displayName, kind) =>
            setPendingDelete({ path, displayName, kind })
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
        pending={pendingDelete}
        busy={deleting}
        error={deleteError}
        description={`This permanently removes the ${kindNoun(pendingDelete?.kind)} from this browser. There is no undo.`}
        onCancel={() => {
          setPendingDelete(null)
          setDeleteError(null)
        }}
        onConfirm={() => void handleConfirmDelete()}
      />
    </div>
  )
}
