import { useEffect, useMemo, useState } from 'react'
import { useThemeMode } from '../../hooks/useThemeMode.js'
import {
  DaemonApiError,
  getDocumentOkfV1,
  getDocumentSnapshot,
  listDocuments,
} from '../../lib/daemon-api-client.js'
import { DocumentPreview } from './DocumentPreview.js'
import { DocumentThumbnail } from './DocumentThumbnail.js'
import type { WorkspaceDocumentEntry } from './document-entry.js'
import { FolderBreadcrumb } from './FolderBreadcrumb.js'
import { FolderContentsList } from './FolderContentsList.js'
import { createRowRenderLoader } from './load-row-render.js'
import { WorkspaceFolderTree } from './WorkspaceFolderTree.js'

export interface WorkspaceFilesPanelProps {
  daemonFetch: typeof globalThis.fetch
  daemonBaseUrl: string
  workspaceId: string
  /** Absent means the preview shows no way in — looking still works. */
  onOpenDocument?: (path: string) => void
}

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
}: WorkspaceFilesPanelProps) {
  const { resolvedTheme } = useThemeMode()
  const [documents, setDocuments] = useState<WorkspaceDocumentEntry[] | null>(null)
  // 'not-found' is a workspace with no v1 tree yet — a calm empty state, not
  // a failure. 'error' is a genuine fetch/schema failure and keeps the alert.
  const [listStatus, setListStatus] = useState<'ok' | 'not-found' | 'error'>('ok')
  const [selected, setSelected] = useState<WorkspaceDocumentEntry | null>(null)
  // '' is the workspace root, which is where a freshly loaded tree starts.
  const [folder, setFolder] = useState('')

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

  useEffect(() => {
    let cancelled = false
    setDocuments(null)
    setListStatus('ok')
    setSelected(null)
    setFolder('')
    // The RICH list, not /api/v1's: that one carries only {documentId, path},
    // so the tree could label a row by nothing but its path segment and had
    // no way to know a document's kind. Both are things the tree has to show.
    listDocuments(daemonFetch, daemonBaseUrl, workspaceId)
      .then((res) => {
        if (cancelled) return
        setDocuments(
          res.documents.map((entry) => ({
            // An older daemon omits the id; the path stands in, as it does
            // everywhere else that reads this list.
            documentId: entry.id ?? entry.path,
            path: entry.path,
            ...(entry.displayName === undefined ? {} : { name: entry.displayName }),
            ...(entry.kind === undefined ? {} : { kind: entry.kind }),
            ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
          })),
        )
      })
      .catch((err) => {
        if (cancelled) return
        setListStatus(err instanceof DaemonApiError && err.status === 404 ? 'not-found' : 'error')
      })
    return () => {
      cancelled = true
    }
  }, [daemonFetch, daemonBaseUrl, workspaceId])

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
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row"
      data-testid="workspace-files-panel"
    >
      {/* Below md the tree goes: the middle pane's breadcrumb already walks
          the same hierarchy, and three columns in a phone's width leaves
          none of them readable. */}
      <div className="hidden w-56 shrink-0 overflow-y-auto border-r pr-3 md:block">
        <WorkspaceFolderTree
          documents={documents}
          onSelectFolder={selectFolder}
          selectedFolder={folder}
        />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto md:border-r md:pr-3">
        <FolderBreadcrumb folder={folder} onSelect={selectFolder} />
        <div data-testid="folder-contents">
          <FolderContentsList
            documents={documents}
            folder={folder}
            selectedPath={selected?.path}
            onOpen={(target) =>
              target.kind === 'folder' ? selectFolder(target.path) : setSelected(target.document)
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
      <div className="w-full shrink-0 overflow-y-auto md:w-72">
        <DocumentPreview
          document={selected}
          loadRender={loadRender}
          {...(onOpenDocument === undefined
            ? {}
            : { onOpen: (entry: WorkspaceDocumentEntry) => onOpenDocument(entry.path) })}
          className="h-full"
        />
      </div>
    </div>
  )
}
