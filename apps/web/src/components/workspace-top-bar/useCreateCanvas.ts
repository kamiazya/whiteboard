import { problemDetailsErrorSchema } from '@kamiazya/whiteboard-mcp/api-contracts'
import type { MutableRefObject } from 'react'
import { useRef, useState } from 'react'
import { deriveNewCanvasSlug } from '../../lib/derive-new-canvas-slug.js'
import type { CanvasInfo } from './types'

interface UseCreateCanvasOptions {
  workspaceId: string
  slug: string
  canvases: CanvasInfo[]
  isLocalMode: boolean
  onCreateCanvas: (() => void | Promise<void>) | undefined
  onNavigateToCanvas: (slug: string) => void
  daemonFetch: typeof globalThis.fetch
  // Shared with rename/copy — a single mountedRef guards every async write in
  // this top bar against setState-after-unmount when a canvas switch/delete
  // resolves mid-flight.
  mountedRef: MutableRefObject<boolean>
}

// New canvas flow, both modes: create IMMEDIATELY, name afterwards (ADR-0006
// point 3 — a name field before the object exists is the shape this replaced).
// Local mode hands off to onCreateCanvas; daemon mode derives a slug from the
// loaded list — inside the current group, so creating from "design/foo" yields
// "design/untitled", preserving the grouping the old dialog seeded — and POSTs
// it. Failures surface through newCanvasError's existing role="alert" line.
export function useCreateCanvas({
  workspaceId,
  slug,
  canvases,
  isLocalMode,
  onCreateCanvas,
  onNavigateToCanvas,
  daemonFetch,
  mountedRef,
}: UseCreateCanvasOptions) {
  const [newCanvasError, setNewCanvasError] = useState<string | null>(null)
  // Two carriers on purpose: the STATE renders the accessible "Creating…"
  // status (the deleted dialog's disabled Create button was the flow's only
  // in-flight indication — accessibility criterion 5 requires an announced
  // replacement), while the REF is the double-fire guard, because state read
  // from this closure is stale for a second call
  // in the same tick, which is exactly the double-fire this guard exists to
  // stop (the same reasoning that removed the state-read guard from
  // DaemonIndexPage — an unprovable guard is worse than none).
  const busyRef = useRef(false)
  const [newCanvasBusy, setNewCanvasBusy] = useState(false)

  const openNewCanvas = () => {
    if (busyRef.current) return
    busyRef.current = true
    setNewCanvasBusy(true)
    setNewCanvasError(null)
    void (async () => {
      try {
        if (isLocalMode) {
          await onCreateCanvas?.()
          return
        }
        const ix = slug.indexOf('/')
        const prefix = ix !== -1 ? slug.slice(0, ix + 1) : ''
        const scoped = canvases
          .filter((c) => c.slug.startsWith(prefix))
          .map((c) => c.slug.slice(prefix.length))
        const target = `${prefix}${deriveNewCanvasSlug(scoped)}`
        const res = await daemonFetch(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/canvases`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug: target }),
          },
        )
        if (res.ok) {
          onNavigateToCanvas(target)
          return
        }
        const parsed = problemDetailsErrorSchema.safeParse(await res.json().catch(() => ({})))
        // Use the Problem Details title when present; otherwise show a safe
        // generic message. Never expose body.message or Error.message — those
        // can contain server-side paths or credentials (P-HTTP-005).
        const title = parsed.success ? parsed.data.title : undefined
        if (mountedRef.current) setNewCanvasError(title ? title : 'Failed to create canvas.')
      } catch {
        if (mountedRef.current) setNewCanvasError('Failed to create canvas.')
      } finally {
        busyRef.current = false
        if (mountedRef.current) setNewCanvasBusy(false)
      }
    })()
  }

  return {
    newCanvasError,
    newCanvasBusy,
    openNewCanvas,
  }
}
