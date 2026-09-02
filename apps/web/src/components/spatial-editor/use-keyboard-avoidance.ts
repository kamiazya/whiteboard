// On touch devices the virtual keyboard OVERLAYS the page rather than
// resizing it (Chrome's default interactive-widget mode, and iOS Safari
// always), so the app's layout never learns that its lower half became
// invisible — a node being edited there stays hidden for the whole edit.
// The only signal the platform gives is `window.visualViewport` shrinking.
// While a text edit is open, this hook watches that signal and pans the
// canvas — panning is the medium's own verb, so nothing else about the
// editing experience changes — the least it can so the edited node stays
// inside the visible strip above the keyboard.

import { useEffect } from 'react'
import type { BBoxLike, ContainerSize, Viewport } from './viewport.js'
import { panToShowTarget } from './viewport.js'

/**
 * Screen px kept visible below the edited node's box, so the exit strip
 * rendered just under it rises above the keyboard too. Sized for the strip's
 * touch form — the 24px ✓/✕ pill a phone shows, its 6px gap, and the pill's
 * widened tap band — since a phone is where a keyboard occludes anything.
 */
export const EXIT_HINT_ALLOWANCE_PX = 40

/**
 * How many px of the root's bottom the on-screen keyboard covers. Client
 * rects are layout-viewport coordinates; the visual viewport's offsetTop +
 * height is its bottom edge in the same coordinates, so anything of the
 * root below that edge is under the keyboard (or off-screen, which needs
 * the same pan). Never negative: a root fully above the edge is unoccluded.
 */
export function keyboardOccludedBottomPx(
  rootBottomPx: number,
  visual: { readonly height: number; readonly offsetTop: number },
): number {
  return Math.max(0, rootBottomPx - (visual.offsetTop + visual.height))
}

export interface KeyboardAvoidanceInputs {
  /** The edited node's canvas-space box, while a text edit is open. */
  readonly editingBox: BBoxLike | undefined
  readonly rootRef: { readonly current: HTMLDivElement | null }
  readonly containerSizeOf: (root: HTMLDivElement | null) => ContainerSize | null
  readonly setViewport: (updater: (viewport: Viewport) => Viewport) => void
}

export function useKeyboardAvoidance({
  editingBox,
  rootRef,
  containerSizeOf,
  setViewport,
}: KeyboardAvoidanceInputs): void {
  // Primitive deps: the box arrives as a fresh object every render.
  const { x, y, width, height } = editingBox ?? { x: 0, y: 0, width: 0, height: 0 }
  const editing = editingBox !== undefined
  useEffect(() => {
    if (!editing) return
    const visual = window.visualViewport
    if (visual === null || visual === undefined) return
    const apply = () => {
      const root = rootRef.current
      if (root === null) return
      const containerSize = containerSizeOf(root)
      if (containerSize === null) return
      const occluded = keyboardOccludedBottomPx(root.getBoundingClientRect().bottom, visual)
      if (occluded <= 0) return
      setViewport((viewport) => {
        const target = { x, y, width, height: height + EXIT_HINT_ALLOWANCE_PX / viewport.zoom }
        return panToShowTarget(target, viewport, containerSize, { bottom: occluded }) ?? viewport
      })
    }
    // The keyboard may already be up (editing one node, then tapping into
    // another), so run once on entry; after that, resize covers the
    // keyboard animating in and scroll covers iOS panning its visual
    // viewport, which moves the occluded strip without a resize.
    apply()
    visual.addEventListener('resize', apply)
    visual.addEventListener('scroll', apply)
    return () => {
      visual.removeEventListener('resize', apply)
      visual.removeEventListener('scroll', apply)
    }
  }, [editing, x, y, width, height, rootRef, containerSizeOf, setViewport])
}
