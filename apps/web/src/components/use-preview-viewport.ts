/**
 * Pan and zoom for a read-only preview surface.
 *
 * The editor's own navigation cannot be reused here: it lives inside
 * `SpatialEditor`, entangled with the gesture reducer that also moves nodes,
 * and a preview is read-only by construction precisely so no edit path
 * exists (see `DocumentPreview`). What IS shared is the arithmetic —
 * `lib/spatial/viewport.ts` is the one definition of the transform, so a
 * preview and the editor pan and zoom by the same rules.
 *
 * The surface transformed is the drawn SVG, not the scene: a preview renders
 * its canvas fitted to the box once, and a CSS transform over that stays
 * crisp (it is vector) without re-laying-out on every frame. "Canvas space"
 * here is therefore the fitted picture's own pixels, and identity is exactly
 * what the surface drew before anyone touched it.
 */

import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  IDENTITY_VIEWPORT,
  type Point,
  panBy,
  type Viewport,
  zoomAt,
} from '../lib/spatial/viewport.js'

/** Matches the editor's wheel step, so one notch means the same thing on both. */
const ZOOM_WHEEL_FACTOR = 1.1

/**
 * Marks a control drawn OVER the surface (the reset button): spread it onto
 * the control, and a press there is that control's press rather than the
 * start of a pan. Without it the button both resets and, on the way, begins
 * a drag from wherever it sits.
 */
export const PREVIEW_CONTROL_PROPS = { 'data-preview-control': '' } as const
const PREVIEW_CONTROL_SELECTOR = '[data-preview-control]'

function clientPoint(e: { clientX: number; clientY: number }): Point {
  return { x: e.clientX, y: e.clientY }
}

function localPoint(root: HTMLElement, point: Point): Point {
  const rect = root.getBoundingClientRect()
  return { x: point.x - rect.left, y: point.y - rect.top }
}

function midpointOf(points: readonly Point[]): Point {
  const [a, b] = points
  if (a === undefined || b === undefined) return { x: 0, y: 0 }
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function distanceOf(points: readonly Point[]): number {
  const [a, b] = points
  if (a === undefined || b === undefined) return 0
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * Pointer capture is best-effort here for the same reason it is in the
 * editor: a browser rejects it for a pointerId the platform has no active
 * record of, which programmatic dispatch produces. Losing it only ends the
 * drag early.
 */
function trySetPointerCapture(root: HTMLElement, pointerId: number): void {
  try {
    root.setPointerCapture(pointerId)
  } catch {
    // best-effort — see doc comment above
  }
}

export interface PreviewViewportControls {
  readonly viewport: Viewport
  /** True once the view is off identity, so a way back can be offered. */
  readonly moved: boolean
  readonly reset: () => void
  readonly rootRef: (node: HTMLDivElement | null) => void
  /** Spread onto the element `rootRef` is attached to. */
  readonly surfaceHandlers: {
    readonly onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
    readonly onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
    readonly onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
    readonly onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
    readonly onLostPointerCapture: (e: ReactPointerEvent<HTMLElement>) => void
  }
}

export function usePreviewViewport(): PreviewViewportControls {
  const [viewport, setViewport] = useState<Viewport>(IDENTITY_VIEWPORT)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  // Client-space position per live pointer: one is a drag, two are a pinch.
  const pointers = useRef(new Map<number, Point>())

  // React registers onWheel as a PASSIVE listener, so preventDefault from a
  // synthetic handler is silently ignored and Ctrl/Cmd+wheel would zoom the
  // whole page instead of the preview. Only a { passive: false } native
  // listener can refuse that — the same reason the editor wires its own.
  useEffect(() => {
    if (root === null) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const at = localPoint(root, clientPoint(e))
      if (e.ctrlKey || e.metaKey) {
        const factor = e.deltaY < 0 ? ZOOM_WHEEL_FACTOR : 1 / ZOOM_WHEEL_FACTOR
        setViewport((vp) => zoomAt(vp, at, factor))
        return
      }
      // A wheel moves the content opposite to a drag of the same sign.
      setViewport((vp) => panBy(vp, { x: -e.deltaX, y: -e.deltaY }))
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [root])

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (e.target instanceof Element && e.target.closest(PREVIEW_CONTROL_SELECTOR) !== null) return
    pointers.current.set(e.pointerId, clientPoint(e))
    trySetPointerCapture(e.currentTarget, e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const live = pointers.current
    if (!live.has(e.pointerId)) return
    // A press can end without this surface ever hearing it: capture above is
    // best-effort, so a release OUTSIDE the element delivers no `pointerup`
    // here at all. The entry would then outlive the drag — and cost twice,
    // because the next hover pans with no button down, and the stale entry
    // plus one real finger reads as a pinch. The button state on the move is
    // what the surface still knows, so a mouse reporting none ends the drag.
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      live.delete(e.pointerId)
      return
    }
    const before = [...live.values()]
    live.set(e.pointerId, clientPoint(e))
    const after = [...live.values()]

    if (live.size === 1) {
      const [from] = before
      const [to] = after
      if (from === undefined || to === undefined) return
      setViewport((vp) => panBy(vp, { x: to.x - from.x, y: to.y - from.y }))
      return
    }
    if (live.size !== 2) return

    // A pinch is a pan of the midpoint plus a zoom about where it lands, so
    // the two fingers keep holding the same two points of the picture.
    const spread = distanceOf(before)
    if (spread <= 0) return
    const from = midpointOf(before)
    const to = midpointOf(after)
    const anchor = localPoint(e.currentTarget, to)
    const factor = distanceOf(after) / spread
    setViewport((vp) => zoomAt(panBy(vp, { x: to.x - from.x, y: to.y - from.y }), anchor, factor))
  }, [])

  const releasePointer = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    pointers.current.delete(e.pointerId)
  }, [])

  const reset = useCallback(() => setViewport(IDENTITY_VIEWPORT), [])

  return {
    viewport,
    moved:
      viewport.x !== IDENTITY_VIEWPORT.x ||
      viewport.y !== IDENTITY_VIEWPORT.y ||
      viewport.zoom !== IDENTITY_VIEWPORT.zoom,
    reset,
    rootRef: setRoot,
    surfaceHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: releasePointer,
      onPointerCancel: releasePointer,
      // The other way a press ends unheard: the platform revokes the capture
      // mid-drag. Touch reports no `buttons`, so the guard above cannot cover
      // it — this is what does. The editor answers the same event the same way.
      onLostPointerCapture: releasePointer,
    },
  }
}
