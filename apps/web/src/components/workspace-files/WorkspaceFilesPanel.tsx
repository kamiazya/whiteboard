import { useEffect, useState } from 'react'
import { DaemonApiError, getDocumentOkfV1, listDocuments } from '../../lib/daemon-api-client.js'
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
 * The workspace document tree (`/api/v1`): nested document paths on the
 * left, a read-only OKF markdown preview of the clicked document on the
 * right. Read-only by design — editing stays with the MCP tools until the
 * editor surfaces migrate to the v1 world.
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

  useEffect(() => {
    let cancelled = false
    setDocuments(null)
    setListStatus('ok')
    setPreview({ kind: 'idle' })
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
    <div className="flex min-h-0 flex-1 gap-4" data-testid="workspace-files-panel">
      <div className="w-64 shrink-0 overflow-y-auto border-r pr-3">
        <WorkspaceFileTree documents={documents} onOpen={openDocument} />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto" data-testid="okf-preview">
        {preview.kind === 'idle' && (
          <p className="text-muted-foreground text-sm">Select a canvas to preview its content.</p>
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
