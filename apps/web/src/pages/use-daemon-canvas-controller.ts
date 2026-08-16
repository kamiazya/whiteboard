import type { CanvasSummary, WorkspaceSummary } from '@kamiazya/whiteboard-mcp/api-contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createCanvas as createCanvasApi,
  listCanvases as listCanvasesApi,
  listWorkspaces as listWorkspacesApi,
} from '../lib/daemon-api-client.js'

export interface UseDaemonCanvasControllerOptions {
  daemonBaseUrl: string
  // Absent workspaceId/path is resolved to a default (first workspace / first
  // canvas) on mount — see the resolve effect below.
  workspaceId?: string
  path?: string
  daemonFetch: typeof fetch
}

export interface DaemonCanvasController {
  loading: boolean
  // Fatal: the initial mount resolution never produced a usable
  // workspace/canvas, so there is nothing on screen to fall back to. The page
  // renders this as a full-page error state.
  loadError: string | null
  workspaceId: string | null
  path: string | null
  workspaces: WorkspaceSummary[]
  canvases: CanvasSummary[]
  switchCanvas: (path: string) => void
  switchWorkspace: (workspaceId: string) => Promise<void>
  createCanvas: (path: string) => Promise<void>
  createError: string | null
  // Non-fatal: switchWorkspace only commits the new workspaceId/canvases
  // after listCanvases succeeds, so a failure here leaves the previous
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
 * for DaemonCanvasPage. Deliberately does NOT create or own the
 * CanvasBackend/useCanvasSync connection — that stays in the page component,
 * mirroring BrowserLocalCanvasPage's own useMemo(backend, [documentId]) plus
 * useCanvasSync ownership split.
 */
export function useDaemonCanvasController(
  options: UseDaemonCanvasControllerOptions,
): DaemonCanvasController {
  const { daemonBaseUrl, daemonFetch } = options
  const [workspaceId, setWorkspaceId] = useState<string | null>(options.workspaceId ?? null)
  const [path, setSlug] = useState<string | null>(options.path ?? null)
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [canvases, setCanvases] = useState<CanvasSummary[]>([])
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

        const { canvases: canvasList } = await listCanvasesApi(daemonFetch, daemonBaseUrl, wid)
        if (cancelled || seq !== switchSeqRef.current) return
        setCanvases(canvasList)
        setSlug(options.path ?? canvasList[0]?.path ?? null)
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
    // for the page's lifetime (App.tsx only mounts DaemonCanvasPage once per
    // pairing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const switchCanvas = useCallback((nextSlug: string) => {
    setSlug(nextSlug)
  }, [])

  const switchWorkspace = useCallback(
    async (nextWorkspaceId: string): Promise<void> => {
      switchSeqRef.current += 1
      const seq = switchSeqRef.current
      setCreateError(null)
      setSwitchError(null)
      try {
        const { canvases: list } = await listCanvasesApi(
          daemonFetch,
          daemonBaseUrl,
          nextWorkspaceId,
        )
        if (seq !== switchSeqRef.current) return
        setWorkspaceId(nextWorkspaceId)
        setCanvases(list)
        setSlug(list[0]?.path ?? null)
      } catch (err) {
        // Deliberately setSwitchError, not setLoadError: the previous
        // workspace/canvas selection (and its live editor connection) is
        // still valid, so this must not trip the page's fatal loadError path.
        if (seq === switchSeqRef.current) setSwitchError(errorMessage(err))
      }
    },
    [daemonFetch, daemonBaseUrl],
  )

  const createCanvas = useCallback(
    async (newSlug: string): Promise<void> => {
      if (workspaceId === null) return
      setCreateError(null)
      try {
        const created = await createCanvasApi(daemonFetch, daemonBaseUrl, workspaceId, newSlug)
        const { canvases: refreshed } = await listCanvasesApi(
          daemonFetch,
          daemonBaseUrl,
          workspaceId,
        )
        setCanvases(refreshed)
        setSlug(created.path)
      } catch (err) {
        setCreateError(errorMessage(err))
        // The caller derives its next path from `canvases`. A failure often means that list is
        // already stale (another client took the path) — without a refresh, a retry re-derives
        // the SAME losing path from the same stale list and collides forever. Best-effort:
        // leaving the previous (possibly stale) list is no worse than not trying.
        await listCanvasesApi(daemonFetch, daemonBaseUrl, workspaceId)
          .then(({ canvases: refreshed }) => setCanvases(refreshed))
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
    canvases,
    switchCanvas,
    switchWorkspace,
    createCanvas,
    createError,
    switchError,
  }
}
