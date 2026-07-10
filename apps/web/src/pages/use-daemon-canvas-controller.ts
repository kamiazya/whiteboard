import type { CanvasSummary } from '@kamiazya/whiteboard-mcp/api-contracts'
import { useCallback, useEffect, useState } from 'react'
import {
  createCanvas as createCanvasApi,
  listCanvases as listCanvasesApi,
  listWorkspaces as listWorkspacesApi,
} from '../lib/daemon-api-client.js'

export interface UseDaemonCanvasControllerOptions {
  daemonBaseUrl: string
  // Absent workspaceId/slug is resolved to a default (first workspace / first
  // canvas) on mount — see the resolve effect below.
  workspaceId?: string
  slug?: string
  daemonFetch: typeof fetch
}

export interface DaemonCanvasController {
  loading: boolean
  loadError: string | null
  workspaceId: string | null
  slug: string | null
  canvases: CanvasSummary[]
  switchCanvas: (slug: string) => void
  createCanvas: (slug: string) => Promise<void>
  createError: string | null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'The daemon request failed.'
}

/**
 * Resolves workspace/canvas defaults and owns the canvas-switcher list state
 * for DaemonCanvasPage. Deliberately does NOT create or own the
 * CanvasBackend/useCanvasSync connection — that stays in the page component,
 * mirroring BrowserLocalCanvasPage's own useMemo(backend, [canvasId]) plus
 * useCanvasSync ownership split.
 */
export function useDaemonCanvasController(
  options: UseDaemonCanvasControllerOptions,
): DaemonCanvasController {
  const { daemonBaseUrl, daemonFetch } = options
  const [workspaceId, setWorkspaceId] = useState<string | null>(options.workspaceId ?? null)
  const [slug, setSlug] = useState<string | null>(options.slug ?? null)
  const [canvases, setCanvases] = useState<CanvasSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  // Resolution runs once per mount (daemonBaseUrl/workspaceId/slug come from
  // a stable pairing payload for the lifetime of this page).
  useEffect(() => {
    let cancelled = false

    async function resolve(): Promise<void> {
      try {
        let wid = options.workspaceId ?? null
        if (wid === null) {
          const { workspaces } = await listWorkspacesApi(daemonFetch, daemonBaseUrl)
          if (cancelled) return
          wid = workspaces[0]?.workspaceId ?? null
        }
        if (wid === null) {
          setLoadError('No workspace is available on this daemon.')
          return
        }
        setWorkspaceId(wid)

        const { canvases: list } = await listCanvasesApi(daemonFetch, daemonBaseUrl, wid)
        if (cancelled) return
        setCanvases(list)
        setSlug(options.slug ?? list[0]?.slug ?? null)
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err))
      } finally {
        if (!cancelled) setLoading(false)
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
        setSlug(created.slug)
      } catch (err) {
        setCreateError(errorMessage(err))
      }
    },
    [daemonFetch, daemonBaseUrl, workspaceId],
  )

  return {
    loading,
    loadError,
    workspaceId,
    slug,
    canvases,
    switchCanvas,
    createCanvas,
    createError,
  }
}
