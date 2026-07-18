import { problemDetailsErrorSchema } from '@kamiazya/whiteboard-mcp/api-contracts'
import type { MutableRefObject } from 'react'
import { useState } from 'react'

interface UseCreateCanvasOptions {
  workspaceId: string
  slug: string
  isLocalMode: boolean
  onCreateCanvas: (() => void | Promise<void>) | undefined
  onNavigateToCanvas: (slug: string) => void
  daemonFetch: typeof globalThis.fetch
  // Shared with rename/copy — a single mountedRef guards every async write in
  // this top bar against setState-after-unmount when a canvas switch/delete
  // resolves mid-flight.
  mountedRef: MutableRefObject<boolean>
}

// New canvas flow: local mode has no slug to POST — hand off straight to
// onCreateCanvas and skip the daemon-only slug dialog entirely. Daemon mode
// opens a dialog, seeded with the current group's prefix for faster repeated
// creation, then POSTs /canvases and lets the caller navigate on success.
export function useCreateCanvas({
  workspaceId,
  slug,
  isLocalMode,
  onCreateCanvas,
  onNavigateToCanvas,
  daemonFetch,
  mountedRef,
}: UseCreateCanvasOptions) {
  const [newCanvasOpen, setNewCanvasOpen] = useState(false)
  const [newCanvasSlug, setNewCanvasSlug] = useState('')
  const [newCanvasError, setNewCanvasError] = useState<string | null>(null)
  const [newCanvasBusy, setNewCanvasBusy] = useState(false)

  const openNewCanvas = () => {
    if (isLocalMode) {
      if (newCanvasBusy) return
      setNewCanvasBusy(true)
      setNewCanvasError(null)
      void (async () => {
        try {
          await onCreateCanvas?.()
        } catch {
          if (mountedRef.current) setNewCanvasError('Failed to create canvas.')
        } finally {
          if (mountedRef.current) setNewCanvasBusy(false)
        }
      })()
      return
    }
    const ix = slug.indexOf('/')
    const prefix = ix !== -1 ? `${slug.slice(0, ix)}/` : ''
    setNewCanvasSlug(prefix)
    setNewCanvasError(null)
    setNewCanvasOpen(true)
  }

  const submitNewCanvas = async () => {
    if (newCanvasBusy) return
    const target = newCanvasSlug.trim()
    if (!target || target.endsWith('/')) {
      setNewCanvasError('Enter a slug (e.g. "design/foo" or "quick-note").')
      return
    }
    setNewCanvasBusy(true)
    setNewCanvasError(null)
    try {
      const res = await daemonFetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/canvases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: target }),
      })
      if (res.ok) {
        setNewCanvasOpen(false)
        setNewCanvasSlug('')
        onNavigateToCanvas(target)
        return
      }
      const parsed = problemDetailsErrorSchema.safeParse(await res.json().catch(() => ({})))
      // Use the Problem Details title when present; otherwise show a safe
      // generic message. Never expose body.message or Error.message — those
      // can contain server-side paths or credentials (P-HTTP-005).
      const title = parsed.success ? parsed.data.title : undefined
      setNewCanvasError(title ? title : 'Failed to create canvas.')
    } catch {
      setNewCanvasError('Failed to create canvas.')
    } finally {
      setNewCanvasBusy(false)
    }
  }

  return {
    newCanvasOpen,
    newCanvasSlug,
    newCanvasError,
    newCanvasBusy,
    setNewCanvasOpen,
    setNewCanvasSlug,
    setNewCanvasError,
    openNewCanvas,
    submitNewCanvas,
  }
}
