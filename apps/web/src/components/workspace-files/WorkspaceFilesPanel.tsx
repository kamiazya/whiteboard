import { useEffect, useState } from 'react'
import { DaemonApiError, getCanvasOkfV1, listCanvasesV1 } from '../../lib/daemon-api-client.js'
import { WorkspaceFileTree, type WorkspaceFileTreeCanvas } from './WorkspaceFileTree.js'

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
 * The OpenCanvas workspace file tree (/api/v1): nested document paths on the
 * left, a read-only OKF markdown preview of the clicked canvas on the
 * right. Read-only by design — editing OpenCanvas docs stays with the MCP
 * tools until the editor surfaces migrate to the v1 world.
 */
export function WorkspaceFilesPanel({
  daemonFetch,
  daemonBaseUrl,
  workspaceId,
}: WorkspaceFilesPanelProps) {
  const [canvases, setCanvases] = useState<WorkspaceFileTreeCanvas[] | null>(null)
  // 'not-found' is a workspace with no v1 tree yet — a calm empty state, not
  // a failure. 'error' is a genuine fetch/schema failure and keeps the alert.
  const [listStatus, setListStatus] = useState<'ok' | 'not-found' | 'error'>('ok')
  const [preview, setPreview] = useState<OkfPreview>({ kind: 'idle' })

  useEffect(() => {
    let cancelled = false
    setCanvases(null)
    setListStatus('ok')
    setPreview({ kind: 'idle' })
    listCanvasesV1(daemonFetch, daemonBaseUrl, workspaceId)
      .then((res) => {
        if (!cancelled) setCanvases(res.canvases)
      })
      .catch((err) => {
        if (cancelled) return
        setListStatus(err instanceof DaemonApiError && err.status === 404 ? 'not-found' : 'error')
      })
    return () => {
      cancelled = true
    }
  }, [daemonFetch, daemonBaseUrl, workspaceId])

  const openCanvas = (canvas: WorkspaceFileTreeCanvas) => {
    setPreview({ kind: 'loading', path: canvas.path })
    getCanvasOkfV1(daemonFetch, daemonBaseUrl, workspaceId, canvas.canvasId)
      .then((res) => {
        setPreview((current) =>
          current.kind === 'loading' && current.path === canvas.path
            ? { kind: 'loaded', path: canvas.path, markdown: res.markdown }
            : current,
        )
      })
      .catch(() => {
        setPreview((current) =>
          current.kind === 'loading' && current.path === canvas.path
            ? // A created-but-never-written canvas 404s; show it as empty
              // rather than as a failure (see the /okf route's contract).
              { kind: 'empty', path: canvas.path }
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
    return (
      <p className="text-muted-foreground text-sm">This workspace has no OpenCanvas tree yet.</p>
    )
  }
  if (canvases === null) {
    return <p className="text-muted-foreground text-sm">Loading files…</p>
  }

  return (
    <div className="flex min-h-0 flex-1 gap-4" data-testid="workspace-files-panel">
      <div className="w-64 shrink-0 overflow-y-auto border-r pr-3">
        <WorkspaceFileTree canvases={canvases} onOpen={openCanvas} />
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
