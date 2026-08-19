import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DeleteDocumentDialog } from '../components/document-list/DeleteDocumentDialog.js'
import { DocumentListView } from '../components/document-list/DocumentListView.js'
import { newDocumentPathIn } from '../components/workspace-files/new-document-path.js'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { LOCAL_WORKSPACE_ID } from '../lib/browser-local-store.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'

export interface BrowserLocalIndexPageProps {
  store: BrowserLocalStore
  onOpenDocument: (documentId: string) => void
}

// The browser-local landing surface: the same shared list the daemon gallery
// renders, minus its daemon-only capabilities (no thumbnails, no workspace
// selector). Rows come straight from the store; the editor page owns
// everything after onOpenDocument fires.
export function BrowserLocalIndexPage({ store, onOpenDocument }: BrowserLocalIndexPageProps) {
  const [snapshots, setSnapshots] = useState<DocumentSnapshot[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The `disabled` attribute (via createDisabled) is the whole double-press
  // mechanism: React flushes this state before a second click can dispatch,
  // and a handler-side `if (creating) return` reads a stale closure in
  // exactly the same-tick case it would have to catch.
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let cancelled = false
    store
      .listDocuments()
      .then((all) => {
        if (!cancelled) setSnapshots(all)
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load documents from this browser.')
      })
    return () => {
      cancelled = true
    }
  }, [store])

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

  const [pendingDelete, setPendingDelete] = useState<{ id: string; displayName: string } | null>(
    null,
  )
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    setDeleting(true)
    setDeleteError(null)
    try {
      // Unconditional removal by id. If this was the canvas the default
      // pointer resumes into, the pointer dangles deliberately — the
      // editor's resume path already falls back safely on a dead id.
      await store.removeDocument?.(pendingDelete.id)
      setSnapshots(await store.listDocuments())
      setPendingDelete(null)
    } catch {
      setDeleteError('Failed to delete the canvas from this browser.')
    } finally {
      setDeleting(false)
    }
  }, [store, pendingDelete])

  const handleCreate = useCallback(
    async (kind: DocumentKind) => {
      setCreating(true)
      try {
        const id = store.generateId()
        const fresh: DocumentSnapshot = {
          documentId: id,
          workspaceId: LOCAL_WORKSPACE_ID,
          // A create while the list is still loading numbers from nothing.
          // The store rejects a duplicate path, so the worst case is a
          // refused create rather than two documents at one address.
          path: newDocumentPathIn(
            '',
            (snapshots ?? []).map((row) => row.path),
          ),
          name: 'untitled',
          updatedAt: new Date().toISOString(),
          kind,
        }
        await store.save(fresh)
        // Repointed so a later plain load resumes in the new canvas — the
        // same contract the editor's own create/switch flows keep.
        await store.setDefaultDocumentId(id)
        onOpenDocument(id)
      } catch {
        setError('Failed to create a canvas in this browser.')
      } finally {
        setCreating(false)
      }
    },
    [store, onOpenDocument],
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
                setPendingDelete({ id: row.path, displayName: row.displayName })
              }}
              className="absolute right-1 top-1 rounded-md border bg-background px-1.5 py-0.5 text-xs font-medium opacity-0 transition-opacity hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100"
            >
              Delete
            </button>
          )}
        />
      ) : (
        // Load failed (error set, snapshots never arrived): creating does
        // not need the list — a fresh id + save routes around the broken
        // read, and success navigates into the new canvas.
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
