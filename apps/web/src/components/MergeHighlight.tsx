import { useEffect, useRef, useState, type JSX } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { MERGE_COMMITTED_EVENT, parseMergeCommittedEvent } from '@/lib/merge-committed-event'

// Highlight new elements in emerald and conflicts in amber for a short time after merge.
// This sits in a pointer-events:none overlay so it does not interfere with Excalidraw drawing.
// - Convert world coordinates into viewport coordinates with scrollX/scrollY/zoom
// - Fade out after a short delay
// - Listen to excalidraw:merge_committed for the affected element IDs

export interface MergeHighlightProps {
  workspaceId: string
  slug: string
  apiRef: React.MutableRefObject<ExcalidrawImperativeAPI | null>
}

interface HighlightBox {
  id: string
  kind: 'new' | 'conflict'
  // World coordinates in Excalidraw space.
  x: number
  y: number
  w: number
  h: number
}

// Track viewport changes with requestAnimationFrame while highlights are visible.
export function MergeHighlight({
  workspaceId,
  slug,
  apiRef,
}: MergeHighlightProps): JSX.Element | null {
  const [boxes, setBoxes] = useState<HighlightBox[] | null>(null)
  const [scroll, setScroll] = useState({ x: 0, y: 0, zoom: 1 })
  const rafRef = useRef<number | null>(null)
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (event: Event) => {
      // Validate-then-commit: parse the detail fully before touching state so a
      // malformed/null event leaves any previously-shown boxes untouched.
      const detail = parseMergeCommittedEvent(event)
      if (!detail) return
      if (detail.workspaceId !== workspaceId || detail.slug !== slug) return
      const api = apiRef.current
      if (!api) return
      const scene = api.getSceneElements()
      // Use the absolute world-space boxes that Excalidraw renders from.
      const byId = new Map<string, ExcalidrawElement>()
      for (const el of scene) byId.set(el.id, el)
      const resolved: HighlightBox[] = []
      for (const id of detail.newElementIds) {
        const el = byId.get(id)
        if (!el) continue
        resolved.push({ id, kind: 'new', x: el.x, y: el.y, w: el.width, h: el.height })
      }
      for (const id of detail.conflictElementIds) {
        const el = byId.get(id)
        if (!el) continue
        resolved.push({ id, kind: 'conflict', x: el.x, y: el.y, w: el.width, h: el.height })
      }
      if (resolved.length === 0) return
      setBoxes(resolved)
      // Clear after the visible/fade-out window expires.
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
      fadeTimerRef.current = setTimeout(() => {
        setBoxes(null)
      }, 2500)
    }
    window.addEventListener(MERGE_COMMITTED_EVENT, handler)
    return () => {
      window.removeEventListener(MERGE_COMMITTED_EVENT, handler)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    }
  }, [workspaceId, slug, apiRef])

  // Poll scroll and zoom only while visible.
  // Excalidraw already emits appState through onChange, but adding a dedicated subscription just for this
  // overlay would add more coupling than needed.
  useEffect(() => {
    if (!boxes) return
    const tick = () => {
      const api = apiRef.current
      if (api) {
        const st = api.getAppState()
        setScroll({
          x: st.scrollX ?? 0,
          y: st.scrollY ?? 0,
          zoom: (st.zoom?.value as number) ?? 1,
        })
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [boxes, apiRef])

  if (!boxes || boxes.length === 0) return null

  return (
    <div
      aria-hidden
      data-testid="merge-highlight-layer"
      className="pointer-events-none absolute inset-0 z-40"
    >
      {boxes.map((b) => {
        // World -> viewport conversion: viewportX = (worldX + scrollX) * zoom
        const vx = (b.x + scroll.x) * scroll.zoom
        const vy = (b.y + scroll.y) * scroll.zoom
        const vw = b.w * scroll.zoom
        const vh = b.h * scroll.zoom
        const color = b.kind === 'new' ? '#10b981' : '#f59e0b'
        return (
          <div
            key={`${b.kind}-${b.id}`}
            data-testid={`merge-highlight-${b.kind}`}
            className="merge-highlight-box"
            style={{
              position: 'absolute',
              left: `${vx - 4}px`,
              top: `${vy - 4}px`,
              width: `${vw + 8}px`,
              height: `${vh + 8}px`,
              borderRadius: '6px',
              boxShadow: `0 0 0 3px ${color}, 0 0 18px ${color}55`,
              animation: 'mergeHighlightFade 2500ms ease-out forwards',
            }}
          />
        )
      })}
      <style>{`@keyframes mergeHighlightFade {
        0% { opacity: 0; transform: scale(1.06); }
        20% { opacity: 1; transform: scale(1); }
        80% { opacity: 1; }
        100% { opacity: 0; }
      }`}</style>
    </div>
  )
}

export default MergeHighlight
