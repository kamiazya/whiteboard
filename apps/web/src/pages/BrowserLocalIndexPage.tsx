import type { CanvasKind } from '@kamiazya/whiteboard-canvas-model'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppShell } from '../components/AppShell.js'
import { CanvasListView } from '../components/canvas-list/CanvasListView.js'
import { DeleteCanvasDialog } from '../components/canvas-list/DeleteCanvasDialog.js'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import type { CanvasSnapshot } from '../lib/whiteboard-client.js'

export interface BrowserLocalIndexPageProps {
  store: BrowserLocalStore
  onOpenCanvas: (canvasId: string) => void
}

// The browser-local landing surface: the same shared list the daemon gallery
// renders, minus its daemon-only capabilities (no thumbnails, no workspace
// selector). Rows come straight from the store; the editor page owns
// everything after onOpenCanvas fires.
export function BrowserLocalIndexPage({ store, onOpenCanvas }: BrowserLocalIndexPageProps) {
  const [snapshots, setSnapshots] = useState<CanvasSnapshot[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The `disabled` attribute (via createDisabled) is the whole double-press
  // mechanism: React flushes this state before a second click can dispatch,
  // and a handler-side `if (creating) return` reads a stale closure in
  // exactly the same-tick case it would have to catch.
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    let cancelled = false
    store
      .listCanvases()
      .then((all) => {
        if (!cancelled) setSnapshots(all)
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load canvases from this browser.')
      })
    return () => {
      cancelled = true
    }
  }, [store])

  const rows = useMemo(() => {
    if (!snapshots) return []
    const sorted = [...snapshots].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    // No `secondary`: a browser-local canvas is addressed by UUID and has no
    // slug. Deriving a label from the name instead collapses every non-Latin
    // name to `untitled`/`untitled-2` — indistinguishable in the one column
    // that exists to distinguish rows (ADR-0008).
    return sorted.map((s) => ({
      slug: s.id,
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
      await store.removeCanvas?.(pendingDelete.id)
      setSnapshots(await store.listCanvases())
      setPendingDelete(null)
    } catch {
      setDeleteError('Failed to delete the canvas from this browser.')
    } finally {
      setDeleting(false)
    }
  }, [store, pendingDelete])

  const handleCreate = useCallback(
    async (kind: CanvasKind) => {
      setCreating(true)
      try {
        const id = store.generateId()
        const fresh: CanvasSnapshot = {
          id,
          name: 'untitled',
          updatedAt: new Date().toISOString(),
          kind,
        }
        await store.save(fresh)
        // Repointed so a later plain load resumes in the new canvas — the
        // same contract the editor's own create/switch flows keep.
        await store.setDefaultCanvasId(id)
        onOpenCanvas(id)
      } catch {
        setError('Failed to create a canvas in this browser.')
      } finally {
        setCreating(false)
      }
    },
    [store, onOpenCanvas],
  )

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <AppShell daemonConnected={false} />
      <h1 className="sr-only">Canvases</h1>
      {error && (
        <div role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {snapshots === null && !error ? (
        <div
          role="status"
          aria-label="Loading canvases"
          className="skeleton-appear grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
        >
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse rounded-lg border p-2">
              <div className="mt-2 h-4 w-2/3 rounded bg-muted" />
            </div>
          ))}
        </div>
      ) : snapshots !== null ? (
        <CanvasListView
          rows={rows}
          onOpen={onOpenCanvas}
          onCreate={(kind) => void handleCreate(kind)}
          createDisabled={creating}
          renderActions={(row) => (
            <button
              type="button"
              aria-label={`Delete ${row.displayName}`}
              onClick={(event) => {
                // Prevents the click from bubbling to the wrapping open-button.
                event.stopPropagation()
                setPendingDelete({ id: row.slug, displayName: row.displayName })
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
      <DeleteCanvasDialog
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
