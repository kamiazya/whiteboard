import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DeleteDocumentDialog } from '../components/document-list/DeleteDocumentDialog.js'
import { DocumentListView } from '../components/document-list/DocumentListView.js'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
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
    // No `secondary`: a browser-local canvas is addressed by UUID and has no
    // path. Deriving a label from the name instead collapses every non-Latin
    // name to `untitled`/`untitled-2` — indistinguishable in the one column
    // that exists to distinguish rows (ADR-0008).
    return sorted.map((s) => ({
      path: s.id,
      displayName: s.name,
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
          id,
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
