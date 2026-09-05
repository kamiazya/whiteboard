// On touch devices the virtual keyboard OVERLAYS the page rather than
// resizing it (Chrome's default interactive-widget mode, and iOS Safari
// always), so the app's layout never learns that its lower half became
// invisible — whatever is being typed into down there stays hidden for the
// whole edit. The only signal the platform gives is `window.visualViewport`
// shrinking. Whenever a text entry inside the canvas root has focus, this
// hook watches that signal and pans the canvas — panning is the medium's
// own verb, so nothing else about the editing experience changes — the
// least it can so the thing being typed into stays inside the visible strip
// above the keyboard.
//
// Driven by FOCUS, not by which editor the parent believes is open. The
// first version took the edited node's box from the parent, which wired it
// for node text and for nothing else: the comment compose bubble, an edge
// or group label, and the thread card's reply box each summoned the same
// keyboard over the same strip and got no pan, because each was a call site
// someone had to remember. Focus is the event that raises a keyboard, and
// every text entry raises it the same way, so it is the one signal that
// cannot be forgotten per editor.

import { useEffect, useRef } from 'react'
import {
  canvasVerbBarShown,
  DESKTOP_BAR_HEIGHT_PX,
  TOUCH_BAR_HEIGHT_PX,
  touchFormattingBarShown,
} from '../markdown-editor/verb-bar-layout.js'
import type { ContainerSize, Viewport } from './viewport.js'
import { panToShowTarget, screenToCanvas } from './viewport.js'

/**
 * Screen px kept visible below the subject's box while an exit strip is
 * rendered under it, so the strip rises above the keyboard too. Sized for
 * the strip's touch form — the 24px ✓/✕ pill a phone shows, its 6px gap,
 * and the pill's widened tap band — since a phone is where a keyboard
 * occludes anything. Only with a strip on screen: charged to the thread
 * card, which has none and sits slid against the root's bottom edge, it
 * panned the canvas on every tap into the reply box.
 */
export const EXIT_HINT_ALLOWANCE_PX = 40

/** Frames re-checked after a trigger, for a subject the pan itself relocates. */
const SETTLE_PASSES = 3

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

/** `<input>` types a keyboard is raised for; the rest are buttons and pickers. */
const TYPED_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number'])

function isTextEntry(element: Element): boolean {
  if (element instanceof HTMLTextAreaElement) return true
  if (element instanceof HTMLInputElement) return TYPED_INPUT_TYPES.has(element.type)
  return element instanceof HTMLElement && element.isContentEditable
}

/**
 * What to keep visible while the keyboard is up: the overlay that owns the
 * focused text entry, or the entry itself when nothing owns it. The
 * overlay rather than the bare control because that is the unit a reader
 * is looking at — the node editor's frame, the whole thread card with its
 * Reply button — and because a CodeMirror caret lives in a `.cm-content`
 * that is smaller than the editor drawn around it. Null when focus is not
 * on a text entry inside the root, which is also the answer once an editor
 * has unmounted: a removed element fires no blur, so the question is asked
 * fresh of `document.activeElement` each time rather than remembered.
 */
export function keyboardAvoidanceSubject(root: Element): Element | null {
  const active = document.activeElement
  if (active === null || !root.contains(active) || !isTextEntry(active)) return null
  return active.closest('[data-editor-overlay]') ?? active
}

export interface KeyboardAvoidanceInputs {
  readonly rootRef: { readonly current: HTMLDivElement | null }
  readonly containerSizeOf: (root: HTMLDivElement | null) => ContainerSize | null
  readonly setViewport: (updater: (viewport: Viewport) => Viewport) => void
}

export function useKeyboardAvoidance({
  rootRef,
  containerSizeOf,
  setViewport,
}: KeyboardAvoidanceInputs): void {
  // Read through refs so the subscription below outlives a render: both
  // arrive as fresh closures every render, and an effect keyed on them
  // re-subscribed on each — cancelling the settle passes a pan had queued,
  // since the pan's own commit is a render.
  const containerSizeOfRef = useRef(containerSizeOf)
  containerSizeOfRef.current = containerSizeOf
  const setViewportRef = useRef(setViewport)
  setViewportRef.current = setViewport
  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const visual = window.visualViewport ?? null
    const apply = () => {
      const subject = keyboardAvoidanceSubject(root)
      if (subject === null) return
      const containerSize = containerSizeOfRef.current(root)
      if (containerSize === null) return
      const rootRect = root.getBoundingClientRect()
      const occluded = visual === null ? 0 : keyboardOccludedBottomPx(rootRect.bottom, visual)
      // A phone's keyboard carries the formatting bar on top of it, so the
      // strip to clear is the keyboard plus the bar — asked of the bar's own
      // predicate, since a coarse pointer is not the same question (an edge
      // label is edited in a textarea the bar does not attach to).
      const bottom = occluded + (touchFormattingBarShown() ? TOUCH_BAR_HEIGHT_PX : 0)
      // The desktop strip sits under the header, over the canvas's own top
      // edge — a subject opened beneath it is as hidden as one under a keyboard.
      const top = canvasVerbBarShown() ? DESKTOP_BAR_HEIGHT_PX : 0
      // No early return on zero occlusion and no bar. Under
      // `interactive-widget=resizes-content` (index.html) the keyboard
      // shrinks the LAYOUT viewport instead: it occludes nothing and reads
      // as absent from every signal a page has, while the root itself lost
      // half its height — measured on a phone, a card whose reply box had
      // just been tapped sat 340px below a 392px root with both numbers
      // here at zero. Whether the subject fits is a question of the
      // container, and `panToShowTarget` answers undefined when it does, so
      // a pass that finds it visible costs a comparison.
      // Measured on screen and converted back, rather than asked of the
      // parent in canvas units: the thread card is positioned in screen
      // space outside the pan/zoom transform, the editors inside it, and a
      // client rect is the one description both have.
      const rect = subject.getBoundingClientRect()
      const allowance =
        root.querySelector('[data-editor-exit-hint]') === null ? 0 : EXIT_HINT_ALLOWANCE_PX
      const screenBox = {
        x: rect.left - rootRect.left,
        y: rect.top - rootRect.top,
        width: rect.width,
        height: rect.height + allowance,
      }
      setViewportRef.current((viewport) => {
        const origin = screenToCanvas({ x: screenBox.x, y: screenBox.y }, viewport)
        const target = {
          x: origin.x,
          y: origin.y,
          width: screenBox.width / viewport.zoom,
          height: screenBox.height / viewport.zoom,
        }
        return panToShowTarget(target, viewport, containerSize, { top, bottom }) ?? viewport
      })
    }
    // Focus is the entry: the keyboard may already be up (typing into one
    // editor, then tapping into another), so the pass runs at once; after
    // that, resize covers the keyboard animating in and scroll covers iOS
    // panning its visual viewport, which moves the occluded strip without a
    // resize. The layout viewport shrinking is a `window` resize, not a
    // visual one, and it is the only signal the resizes-content path gives.
    // One pass now and a few on the frames after, because the pan can
    // move the subject by other than the pan: the thread card is chrome
    // that slides itself back inside the root's edge, so its measured place
    // is not its natural one, and the first pan lands it short by exactly
    // the slide. Asked again of the settled layout, the pass converges —
    // `panToShowTarget` answers undefined once the subject fits — and it is
    // bounded so a subject that never settles cannot become a pan loop.
    let frame = 0
    const settle = () => {
      cancelAnimationFrame(frame)
      apply()
      let passes = 0
      const again = () => {
        apply()
        passes += 1
        if (passes < SETTLE_PASSES) frame = requestAnimationFrame(again)
      }
      frame = requestAnimationFrame(again)
    }
    root.addEventListener('focusin', settle)
    visual?.addEventListener('resize', settle)
    visual?.addEventListener('scroll', settle)
    window.addEventListener('resize', settle)
    return () => {
      cancelAnimationFrame(frame)
      root.removeEventListener('focusin', settle)
      visual?.removeEventListener('resize', settle)
      visual?.removeEventListener('scroll', settle)
      window.removeEventListener('resize', settle)
    }
  }, [rootRef])
}
