import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { Columns2, FilePlus2, LayoutGrid, List } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useThemeMode } from '../../hooks/useThemeMode.js'
import {
  createDocument,
  DaemonApiError,
  getDocumentOkfV1,
  getDocumentSnapshot,
  listDocuments,
  renameDocumentPath,
} from '../../lib/daemon-api-client.js'
import { DocumentMinimap } from './DocumentMinimap.js'
import { DocumentPreview } from './DocumentPreview.js'
import { DocumentThumbnail } from './DocumentThumbnail.js'
import type { WorkspaceDocumentEntry } from './document-entry.js'
import { FolderBreadcrumb } from './FolderBreadcrumb.js'
import { FolderContentsList } from './FolderContentsList.js'
import { createRowOutlineLoader } from './load-row-outline.js'
import { createRowRenderLoader } from './load-row-render.js'
import { newDocumentPathIn } from './new-document-path.js'
import { WorkspaceFileTree } from './WorkspaceFileTree.js'
import { WorkspaceFolderTree } from './WorkspaceFolderTree.js'

export interface WorkspaceFilesPanelProps {
  daemonFetch: typeof globalThis.fetch
  daemonBaseUrl: string
  workspaceId: string
  /** Absent means the preview shows no way in — looking still works. */
  onOpenDocument?: (path: string) => void
  /**
   * Copy and ask-to-delete. Both stay with the page: it already owns the
   * duplicate that the grid used and the confirmation dialog that guards a
   * delete, and a second copy of either would be a second set of rules for
   * the same destructive act.
   */
  onDuplicateDocument?: (path: string) => void
  onRequestDelete?: (path: string, displayName: string) => void
  /**
   * Any value that changes when the workspace's documents may have changed
   * behind this panel's back.
   *
   * The page performs duplicate and delete on the browser's behalf, and a
   * delete finishes later still, in a confirmation dialog the panel does not
   * own — so neither can be awaited here. Without this the deleted document
   * stayed on screen with a live Delete bound to a path that no longer
   * existed, and a duplicate never appeared at all.
   */
  revision?: unknown
}

/**
 * How many columns stand between the workspace and the preview.
 *
 * `one` is the whole tree — folders and documents together, reachable
 * without moving anything, which is what you want when you know where you
 * are going. `two` splits it: folders on the left, that folder's contents
 * as cards beside them, which is what you want when you are looking rather
 * than navigating. Neither is a subset of the other, which is why this is a
 * toggle and not a width breakpoint.
 */
export type BrowserColumns = 'one' | 'two'

/**
 * The workspace document browser (`/api/v1`), in three panes: the folder
 * sidebar, the contents of the selected folder, and the selected document
 * drawn.
 *
 * Each pane is driven by exactly one to its left, so the three cannot
 * disagree about what is selected. Both the cards and the preview draw from
 * the same renderer at two sizes, so a thumbnail is always a small version
 * of what the preview shows.
 */
export function WorkspaceFilesPanel({
  daemonFetch,
  daemonBaseUrl,
  workspaceId,
  onOpenDocument,
  onDuplicateDocument,
  onRequestDelete,
  revision,
}: WorkspaceFilesPanelProps) {
  const { resolvedTheme } = useThemeMode()
  const [documents, setDocuments] = useState<WorkspaceDocumentEntry[] | null>(null)
  // 'not-found' is a workspace with no v1 tree yet — a calm empty state, not
  // a failure. 'error' is a genuine fetch/schema failure and keeps the alert.
  const [listStatus, setListStatus] = useState<'ok' | 'not-found' | 'error'>('ok')
  const [selected, setSelected] = useState<WorkspaceDocumentEntry | null>(null)
  // '' is the workspace root, which is where a freshly loaded tree starts.
  const [folder, setFolder] = useState('')
  const [columns, setColumns] = useState<BrowserColumns>('two')
  const [createError, setCreateError] = useState<string | null>(null)

  // One loader for the whole panel, so a re-render does not hand every card
  // a new function and re-trigger its render.
  const loadRender = useMemo(
    () =>
      createRowRenderLoader({
        daemonFetch,
        daemonBaseUrl,
        workspaceId,
        theme: resolvedTheme,
        getSnapshot: getDocumentSnapshot,
        getOkf: getDocumentOkfV1,
      }),
    [daemonFetch, daemonBaseUrl, workspaceId, resolvedTheme],
  )

  // The row-size rendition. Separate from `loadRender` on purpose: it asks
  // the worker for block geometry rather than a serialized SVG, which is
  // both cheaper and the only thing legible at 24px (see DocumentMinimap).
  const loadOutline = useMemo(
    () =>
      createRowOutlineLoader({
        daemonFetch,
        daemonBaseUrl,
        workspaceId,
        getSnapshot: getDocumentSnapshot,
        getOkf: getDocumentOkfV1,
      }),
    [daemonFetch, daemonBaseUrl, workspaceId],
  )

  // The RICH list, not /api/v1's: that one carries only {documentId, path},
  // so a row could be labelled by nothing but its path segment and there was
  // no way to know a document's kind. Both are things the browser shows.
  const readList = useCallback(
    () =>
      listDocuments(daemonFetch, daemonBaseUrl, workspaceId).then((res) =>
        res.documents.map((entry) => ({
          // An older daemon omits the id; the path stands in, as it does
          // everywhere else that reads this list.
          documentId: entry.id ?? entry.path,
          path: entry.path,
          ...(entry.displayName === undefined ? {} : { name: entry.displayName }),
          ...(entry.kind === undefined ? {} : { kind: entry.kind }),
          ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
        })),
      ),
    [daemonFetch, daemonBaseUrl, workspaceId],
  )

  useEffect(() => {
    let cancelled = false
    setDocuments(null)
    setListStatus('ok')
    setSelected(null)
    setFolder('')
    readList()
      .then((entries) => {
        if (!cancelled) setDocuments(entries)
      })
      .catch((err) => {
        if (cancelled) return
        setListStatus(err instanceof DaemonApiError && err.status === 404 ? 'not-found' : 'error')
      })
    return () => {
      cancelled = true
    }
  }, [readList])

  // Deliberately NOT the effect above: that one is the workspace changing,
  // and it resets the open folder. A document appearing or disappearing must
  // leave someone exactly where they were standing. The selection is dropped
  // only when the document it pointed at is gone.
  useEffect(() => {
    if (revision === undefined) return
    let cancelled = false
    readList()
      .then((entries) => {
        if (cancelled) return
        setDocuments(entries)
        setSelected((current) =>
          current === null ? null : (entries.find((row) => row.path === current.path) ?? null),
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [revision, readList])

  /**
   * Move a document and re-read the list.
   *
   * A move is the one action here that changes what every pane is showing —
   * a subtree lands somewhere else entirely — so the list is re-read rather
   * than patched. The selection follows the document to its new path,
   * because losing it would leave the preview blank right when someone wants
   * to see that the move landed.
   *
   * The rejection is re-thrown: the pane that asked owns the message, and
   * this is the only place that knows it was the server's words.
   */
  /**
   * Create a document in the folder the browser is standing in.
   *
   * Until now the only way to put a document anywhere but the workspace root
   * was MCP or raw HTTP, which left the browser showing a hierarchy it had
   * no way to add to. No name is collected: naming follows creation
   * (ADR-0006), and a path is never derived from a name (ADR-0008).
   */
  const createHere = useCallback(
    async (kind: DocumentKind) => {
      setCreateError(null)
      const path = newDocumentPathIn(
        folder,
        (documents ?? []).map((row) => row.path),
      )
      await createDocument(daemonFetch, daemonBaseUrl, workspaceId, path, kind)
      const entries = await readList()
      setDocuments(entries)
      setSelected(entries.find((row) => row.path === path) ?? null)
    },
    [daemonFetch, daemonBaseUrl, workspaceId, readList, folder, documents],
  )

  const moveDocument = useCallback(
    async (entry: WorkspaceDocumentEntry, newPath: string) => {
      await renameDocumentPath(daemonFetch, daemonBaseUrl, workspaceId, entry.path, newPath)
      const entries = await readList()
      setDocuments(entries)
      setSelected(entries.find((row) => row.path === newPath) ?? null)
      setFolder(newPath.includes('/') ? newPath.slice(0, newPath.lastIndexOf('/')) : '')
    },
    [daemonFetch, daemonBaseUrl, workspaceId, readList],
  )

  /**
   * Moving the contents pane always empties the preview.
   *
   * A document can only be opened from the folder it lives in, so a preview
   * that survives a folder change is always showing something the contents
   * pane no longer lists — and the pane has no row left to mark, so nothing
   * on screen says which document it belongs to.
   */
  const selectFolder = (path: string) => {
    setFolder(path)
    setSelected(null)
  }

  if (listStatus === 'error') {
    return (
      <p role="alert" className="text-destructive text-sm">
        Failed to load the workspace file tree.
      </p>
    )
  }
  if (listStatus === 'not-found') {
    return <p className="text-muted-foreground text-sm">This workspace has no document tree yet.</p>
  }
  if (documents === null) {
    return <p className="text-muted-foreground text-sm">Loading files…</p>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="workspace-files-panel">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          {/* The trail belongs to whatever narrows the view, and in one-column
              mode nothing does — the tree already shows every level at once. */}
          {columns === 'two' && <FolderBreadcrumb folder={folder} onSelect={selectFolder} />}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="New markdown document"
            onClick={() => void createHere('markdown').catch(() => setCreateError('markdown'))}
            className="text-muted-foreground hover:text-foreground rounded border p-1.5"
          >
            <FilePlus2 className="size-4" />
          </button>
          <button
            type="button"
            aria-label="New canvas"
            onClick={() => void createHere('spatial').catch(() => setCreateError('spatial'))}
            className="text-muted-foreground hover:text-foreground rounded border p-1.5"
          >
            <LayoutGrid className="size-4" />
          </button>
        </div>
        <fieldset className="flex shrink-0 items-center gap-0.5 rounded border p-0.5">
          <legend className="sr-only">Column layout</legend>
          <button
            type="button"
            aria-label="One column"
            aria-pressed={columns === 'one'}
            onClick={() => setColumns('one')}
            className="text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground rounded p-1"
          >
            <List className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Two columns"
            aria-pressed={columns === 'two'}
            onClick={() => setColumns('two')}
            className="text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground rounded p-1"
          >
            <Columns2 className="size-4" />
          </button>
        </fieldset>
      </div>

      {createError !== null && (
        <p role="alert" className="text-destructive text-sm">
          Could not create a {createError} document here.
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
        {columns === 'one' ? (
          <div className="min-w-0 flex-1 overflow-y-auto md:border-r md:pr-3">
            <WorkspaceFileTree
              documents={documents}
              onOpen={setSelected}
              selectedPath={selected?.path}
              renderIcon={(entry) => (
                <DocumentMinimap
                  key={entry.documentId}
                  document={entry}
                  loadOutline={loadOutline}
                />
              )}
            />
          </div>
        ) : (
          <>
            {/* Below md the folder column goes: the breadcrumb already walks
                the same hierarchy, and three columns in a phone's width
                leaves none of them readable. */}
            <div className="hidden w-56 shrink-0 overflow-y-auto border-r pr-3 md:block">
              <WorkspaceFolderTree
                documents={documents}
                onSelectFolder={selectFolder}
                selectedFolder={folder}
              />
            </div>
            <div className="min-w-0 flex-1 overflow-y-auto md:border-r md:pr-3">
              <div data-testid="folder-contents">
                <FolderContentsList
                  documents={documents}
                  folder={folder}
                  selectedPath={selected?.path}
                  onOpen={(target) =>
                    target.kind === 'folder'
                      ? selectFolder(target.path)
                      : setSelected(target.document)
                  }
                  renderThumbnail={(entry) => (
                    <DocumentThumbnail
                      key={entry.documentId}
                      document={entry}
                      loadRender={loadRender}
                      className="size-full"
                    />
                  )}
                />
              </div>
            </div>
          </>
        )}
        <div className="w-full shrink-0 overflow-y-auto md:w-72">
          <DocumentPreview
            document={selected}
            loadRender={loadRender}
            {...(onOpenDocument === undefined
              ? {}
              : { onOpen: (entry: WorkspaceDocumentEntry) => onOpenDocument(entry.path) })}
            onMove={moveDocument}
            {...(onDuplicateDocument === undefined
              ? {}
              : {
                  onDuplicate: (entry: WorkspaceDocumentEntry) => onDuplicateDocument(entry.path),
                })}
            {...(onRequestDelete === undefined
              ? {}
              : {
                  onDelete: (entry: WorkspaceDocumentEntry) =>
                    onRequestDelete(entry.path, entry.name ?? entry.path),
                })}
            className="h-full"
          />
        </div>
      </div>
    </div>
  )
}
