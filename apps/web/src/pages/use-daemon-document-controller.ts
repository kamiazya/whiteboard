import type { DocumentSummary, WorkspaceSummary } from '@kamiazya/whiteboard-mcp/api-contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createDocument as createCanvasApi,
  listDocuments,
  listWorkspaces as listWorkspacesApi,
} from '../lib/daemon-api-client.js'

export interface UseDaemonDocumentControllerOptions {
  daemonBaseUrl: string
  // Absent workspaceId/path is resolved to a default (first workspace / first
  // canvas) on mount — see the resolve effect below.
  workspaceId?: string
  path?: string
  daemonFetch: typeof fetch
}

export interface DaemonDocumentController {
  loading: boolean
  // Fatal: the initial mount resolution never produced a usable
  // workspace/canvas, so there is nothing on screen to fall back to. The page
  // renders this as a full-page error state.
  loadError: string | null
  workspaceId: string | null
  path: string | null
  workspaces: WorkspaceSummary[]
  documents: DocumentSummary[]
  switchDocument: (path: string) => void
  switchWorkspace: (workspaceId: string) => Promise<void>
  createDocument: (path: string) => Promise<void>
  createError: string | null
  // Non-fatal: switchWorkspace only commits the new workspaceId/documents
  // after listDocuments succeeds, so a failure here leaves the previous
  // selection (and the still-connected editor) valid. Kept separate from
  // loadError so the page can show an inline error instead of tearing down
  // the current session.
  switchError: string | null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'The daemon request failed.'
}

/**
 * Resolves workspace/canvas defaults and owns the canvas-switcher list state
 * for DaemonDocumentPage. Deliberately does NOT create or own the
 * DocumentBackend/useDocumentSync connection — that stays in the page component,
 * mirroring BrowserLocalDocumentPage's own useMemo(backend, [documentId]) plus
 * useDocumentSync ownership split.
 */
export function useDaemonDocumentController(
  options: UseDaemonDocumentControllerOptions,
): DaemonDocumentController {
  const { daemonBaseUrl, daemonFetch } = options
  const [workspaceId, setWorkspaceId] = useState<string | null>(options.workspaceId ?? null)
  const [path, setPath] = useState<string | null>(options.path ?? null)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)

  // Monotonic sequence shared by the mount-resolve effect and switchWorkspace
  // so a slower earlier resolution (mount resolve or a stale switch) can
  // never clobber a later, already-committed selection.
  const switchSeqRef = useRef(0)

  // Resolution runs once per mount (daemonBaseUrl/workspaceId/path come from
  // a stable pairing payload for the lifetime of this page). listWorkspaces
  // always runs, even when workspaceId is supplied, so the switcher has a
  // list to show — the real pairing-payload caller always passes a non-null
  // workspaceId, so gating this fetch behind wid===null left it dead code.
  useEffect(() => {
    let cancelled = false
    const seq = switchSeqRef.current

    async function resolve(): Promise<void> {
      try {
        const { workspaces: list } = await listWorkspacesApi(daemonFetch, daemonBaseUrl)
        if (cancelled || seq !== switchSeqRef.current) return
        setWorkspaces(list)

        const wid = options.workspaceId ?? list[0]?.workspaceId ?? null
        if (wid === null) {
          setLoadError('No workspace is available on this daemon.')
          return
        }
        setWorkspaceId(wid)

        const { documents } = await listDocuments(daemonFetch, daemonBaseUrl, wid)
        if (cancelled || seq !== switchSeqRef.current) return
        setDocuments(documents)
        setPath(options.path ?? documents[0]?.path ?? null)
      } catch (err) {
        if (!cancelled && seq === switchSeqRef.current) setLoadError(errorMessage(err))
      } finally {
        if (!cancelled && seq === switchSeqRef.current) setLoading(false)
      }
    }

    void resolve()
    return () => {
      cancelled = true
    }
    // Resolution is a one-shot mount effect; daemonFetch/options are stable
    // for the page's lifetime (App.tsx only mounts DaemonDocumentPage once per
    // pairing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const switchDocument = useCallback((nextPath: string) => {
    setPath(nextPath)
  }, [])

  const switchWorkspace = useCallback(
    async (nextWorkspaceId: string): Promise<void> => {
      switchSeqRef.current += 1
      const seq = switchSeqRef.current
      setCreateError(null)
      setSwitchError(null)
      try {
        const { documents: list } = await listDocuments(daemonFetch, daemonBaseUrl, nextWorkspaceId)
        if (seq !== switchSeqRef.current) return
        setWorkspaceId(nextWorkspaceId)
        setDocuments(list)
        setPath(list[0]?.path ?? null)
      } catch (err) {
        // Deliberately setSwitchError, not setLoadError: the previous
        // workspace/canvas selection (and its live editor connection) is
        // still valid, so this must not trip the page's fatal loadError path.
        if (seq === switchSeqRef.current) setSwitchError(errorMessage(err))
      }
    },
    [daemonFetch, daemonBaseUrl],
  )

  const createDocument = useCallback(
    async (newPath: string): Promise<void> => {
      if (workspaceId === null) return
      setCreateError(null)
      try {
        const created = await createCanvasApi(daemonFetch, daemonBaseUrl, workspaceId, newPath)
        const { documents: refreshed } = await listDocuments(
          daemonFetch,
          daemonBaseUrl,
          workspaceId,
        )
        setDocuments(refreshed)
        setPath(created.path)
      } catch (err) {
        setCreateError(errorMessage(err))
        // The caller derives its next path from `documents`. A failure often means that list is
        // already stale (another client took the path) — without a refresh, a retry re-derives
        // the SAME losing path from the same stale list and collides forever. Best-effort:
        // leaving the previous (possibly stale) list is no worse than not trying.
        await listDocuments(daemonFetch, daemonBaseUrl, workspaceId)
          .then(({ documents: refreshed }) => setDocuments(refreshed))
          .catch(() => {})
      }
    },
    [daemonFetch, daemonBaseUrl, workspaceId],
  )

  return {
    loading,
    loadError,
    workspaceId,
    path,
    workspaces,
    documents,
    switchDocument,
    switchWorkspace,
    createDocument,
    createError,
    switchError,
  }
}
