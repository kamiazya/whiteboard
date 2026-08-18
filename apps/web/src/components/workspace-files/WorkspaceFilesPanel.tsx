import { useEffect, useMemo, useState } from 'react'
import {
  DaemonApiError,
  getDocumentOkfV1,
  getDocumentSnapshot,
  listDocuments,
} from '../../lib/daemon-api-client.js'
import { DocumentMinimap } from './DocumentMinimap.js'
import { FolderContentsList } from './FolderContentsList.js'
import { createRowOutlineLoader } from './load-row-outline.js'
import { WorkspaceFileTree, type WorkspaceFileTreeDocument } from './WorkspaceFileTree.js'

export interface WorkspaceFilesPanelProps {
  daemonFetch: typeof globalThis.fetch
  daemonBaseUrl: string
  workspaceId: string
}

type OkfPreview =
  | { kind: 'idle' }
  | { kind: 'loading'; path: string }
  | { kind: 'loaded'; path: string; markdown: string }
  | { kind: 'empty'; path: string }
  | { kind: 'error'; path: string }

/**
 * The workspace document browser (`/api/v1`), in three panes: the folder
 * tree, the contents of the selected folder, and a read-only OKF preview of
 * the selected document. Read-only by design — editing stays with the MCP
 * tools until the editor surfaces migrate to the v1 world.
 *
 * The tree narrows the middle pane and the middle pane fills the preview, so
 * each pane is driven by exactly one to its left and the three can never
 * disagree about what is selected.
 */
export function WorkspaceFilesPanel({
  daemonFetch,
  daemonBaseUrl,
  workspaceId,
}: WorkspaceFilesPanelProps) {
  const [documents, setDocuments] = useState<WorkspaceFileTreeDocument[] | null>(null)
  // 'not-found' is a workspace with no v1 tree yet — a calm empty state, not
  // a failure. 'error' is a genuine fetch/schema failure and keeps the alert.
  const [listStatus, setListStatus] = useState<'ok' | 'not-found' | 'error'>('ok')
  const [preview, setPreview] = useState<OkfPreview>({ kind: 'idle' })
  // '' is the workspace root, which is where a freshly loaded tree starts.
  const [folder, setFolder] = useState('')

  // One loader for the whole tree, so a re-render does not hand every row a
  // new function and re-trigger its read.
  const loadRowOutline = useMemo(
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

  useEffect(() => {
    let cancelled = false
    setDocuments(null)
    setListStatus('ok')
    setPreview({ kind: 'idle' })
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

  const openDocument = (entry: WorkspaceFileTreeDocument) => {
    setPreview({ kind: 'loading', path: entry.path })
    getDocumentOkfV1(daemonFetch, daemonBaseUrl, workspaceId, entry.documentId)
      .then((res) => {
        setPreview((current) =>
          current.kind === 'loading' && current.path === entry.path
            ? { kind: 'loaded', path: entry.path, markdown: res.markdown }
            : current,
        )
      })
      .catch(() => {
        setPreview((current) =>
          current.kind === 'loading' && current.path === entry.path
            ? // A created-but-never-written document 404s; show it as empty
              // rather than as a failure (see the /okf route's contract).
              { kind: 'empty', path: entry.path }
            : current,
        )
      })
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
        <WorkspaceFileTree
          documents={documents}
          onOpen={openDocument}
          onSelectFolder={setFolder}
          selectedFolder={folder}
          renderIcon={(entry) => (
            <DocumentMinimap key={entry.documentId} document={entry} loadOutline={loadRowOutline} />
          )}
        />
      </div>
      <div className="w-full shrink-0 overflow-y-auto md:w-64 md:border-r md:pr-3">
        <Breadcrumb folder={folder} onSelect={setFolder} />
        <div data-testid="folder-contents">
          <FolderContentsList
            documents={documents}
            folder={folder}
            selectedPath={preview.kind === 'idle' ? undefined : preview.path}
            onOpen={(target) =>
              target.kind === 'folder' ? setFolder(target.path) : openDocument(target.document)
            }
            renderIcon={(entry) => (
              <DocumentMinimap
                key={entry.documentId}
                document={entry}
                loadOutline={loadRowOutline}
              />
            )}
          />
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto" data-testid="okf-preview">
        {preview.kind === 'idle' && (
          <p className="text-muted-foreground text-sm">Select a document to preview its content.</p>
        )}
        {preview.kind === 'loading' && (
          <p className="text-muted-foreground text-sm">Loading {preview.path}…</p>
        )}
        {preview.kind === 'empty' && (
          <p className="text-muted-foreground text-sm">{preview.path} has no content yet.</p>
        )}
        {preview.kind === 'error' && (
          <p role="alert" className="text-destructive text-sm">
            Failed to load {preview.path}.
          </p>
        )}
        {preview.kind === 'loaded' && (
          <>
            <h2 className="mb-2 font-mono text-xs text-muted-foreground">{preview.path}</h2>
            <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 text-sm">
              {preview.markdown}
            </pre>
          </>
        )}
      </div>
    </div>
  )
}

/** Where the middle pane is, and the way back up. */
function Breadcrumb({ folder, onSelect }: { folder: string; onSelect: (path: string) => void }) {
  const segments = folder === '' ? [] : folder.split('/')
  return (
    <nav aria-label="Folder path" className="mb-1 flex flex-wrap items-center gap-0.5 text-xs">
      <BreadcrumbLink label="Workspace" path="" current={folder === ''} onSelect={onSelect} />
      {segments.map((segment, i) => (
        <span key={segments.slice(0, i + 1).join('/')} className="flex items-center gap-0.5">
          <span className="text-muted-foreground">/</span>
          <BreadcrumbLink
            label={segment}
            path={segments.slice(0, i + 1).join('/')}
            current={i === segments.length - 1}
            onSelect={onSelect}
          />
        </span>
      ))}
    </nav>
  )
}

function BreadcrumbLink({
  label,
  path,
  current,
  onSelect,
}: {
  label: string
  path: string
  current: boolean
  onSelect: (path: string) => void
}) {
  return (
    <button
      type="button"
      aria-current={current ? 'true' : undefined}
      onClick={() => onSelect(path)}
      className="hover:text-foreground text-muted-foreground aria-[current]:text-foreground rounded px-1 py-0.5 aria-[current]:font-medium"
    >
      {label}
    </button>
  )
}
