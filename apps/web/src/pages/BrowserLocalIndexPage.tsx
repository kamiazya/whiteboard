import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DeleteDocumentDialog } from '../components/document-list/DeleteDocumentDialog.js'
import { DocumentListView } from '../components/document-list/DocumentListView.js'
import {
  type ContentClock,
  type DefaultDocumentPointer,
  ensureLocalWorkspace,
  IdbDefaultDocumentPointer,
  idbContentClock,
  LOCAL_WORKSPACE_ID,
  listLocalDocuments,
} from '../lib/local-document-summary.js'
import { LoroStore } from '../lib/loro-store.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import {
  createSeededDocument,
  type LoroStoreLike,
} from './use-browser-local-document-controller.js'

export interface BrowserLocalIndexPageProps {
  index: DocumentIndex
  /** Seeds a content record for a newly created document; see handleCreate. */
  loro?: LoroStoreLike
  pointer?: DefaultDocumentPointer
  clock?: ContentClock
  onOpenDocument: (path: string) => void
}

// The browser-local landing surface: the same shared list the daemon gallery
// renders, minus its daemon-only capabilities (no thumbnails, no workspace
// selector). Rows come straight from the store; the editor page owns
// everything after onOpenDocument fires.
export function BrowserLocalIndexPage({
  index,
  loro = new LoroStore(),
  pointer = new IdbDefaultDocumentPointer(),
  clock = idbContentClock(),
  onOpenDocument,
}: BrowserLocalIndexPageProps) {
  const [snapshots, setSnapshots] = useState<DocumentSnapshot[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The `disabled` attribute (via createDisabled) is the whole double-press
  // mechanism: React flushes this state before a second click can dispatch,
  // and a handler-side `if (creating) return` reads a stale closure in
  // exactly the same-tick case it would have to catch.
  const [creating, setCreating] = useState(false)

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
    return () => {
      cancelled = true
    }
  }, [index, clock])

  const rows = useMemo(() => {
    if (!snapshots) return []
    const sorted = [...snapshots].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    // A local document has a real path now, so `secondary` shows it on the
    // same terms the daemon list does: worth a second line only when a
    // display name covers the first. It is still never DERIVED from the name
    // — ADR-0008 measured that and every non-Latin name collapsed to
    // `untitled-N`.
    return sorted.map((s) => ({
      path: s.path,
      displayName: s.name,
      ...(s.name === s.path ? {} : { secondary: s.path }),
      updatedAt: s.updatedAt,
      kind: s.kind,
    }))
  }, [snapshots])

  // The index deletes by PATH, and the list already addresses rows that way,
  // so this carries the path rather than the id it used to need.
  const [pendingDelete, setPendingDelete] = useState<{
    path: string
    displayName: string
  } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    setDeleting(true)
    setDeleteError(null)
    try {
      // If this was the document the default pointer resumes into, the
      // pointer dangles deliberately — the editor's resume path already falls
      // back safely on an id the index no longer holds.
      await index.deleteDocument({ workspaceId: LOCAL_WORKSPACE_ID, path: pendingDelete.path })
      setSnapshots(await listLocalDocuments(index, clock))
      setPendingDelete(null)
    } catch {
      setDeleteError('Failed to delete the canvas from this browser.')
    } finally {
      setDeleting(false)
    }
  }, [index, clock, pendingDelete])

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
        setError('Failed to create a canvas in this browser.')
      } finally {
        setCreating(false)
      }
    },
    [index, loro, clock, pointer, onOpenDocument],
  )

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <h1 className="sr-only">Canvases</h1>
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
      ) : snapshots !== null ? (
        <DocumentListView
          rows={rows}
          onOpen={onOpenDocument}
          onCreate={(kind) => void handleCreate(kind)}
          createDisabled={creating}
          renderActions={(row) => (
            <button
              type="button"
              aria-label={`Delete ${row.displayName}`}
              onClick={(event) => {
                // Prevents the click from bubbling to the wrapping open-button.
                event.stopPropagation()
                setPendingDelete({ path: row.path, displayName: row.displayName })
              }}
              className="absolute right-1 top-1 rounded-md border bg-background px-1.5 py-0.5 text-xs font-medium opacity-0 transition-opacity hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100"
            >
              Delete
            </button>
          )}
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
        description="This permanently removes the canvas from this browser. There is no undo."
        onCancel={() => {
          setPendingDelete(null)
          setDeleteError(null)
        }}
        onConfirm={() => void handleConfirmDelete()}
      />
    </div>
  )
}
