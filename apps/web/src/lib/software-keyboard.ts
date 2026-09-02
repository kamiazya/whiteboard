import { useEffect, useState } from 'react'

/**
 * Where the software keyboard is, read from the one signal the platform
 * gives a page: the visual viewport. Touch browsers overlay the keyboard
 * without resizing the layout viewport, so `innerHeight` stays put while
 * `visualViewport.height` shrinks; the difference (past any `offsetTop`
 * from iOS panning the visual viewport) is the strip the keyboard covers.
 * A hardware keyboard, or a desktop, never shrinks it: occlusion 0.
 */
export interface SoftwareKeyboardState {
  /** Layout-viewport px at the bottom the keyboard covers; 0 when it is down. */
  readonly occludedBottomPx: number
  /** The visual viewport's bottom edge in layout-viewport px — where a keyboard-docked bar sits. */
  readonly visualBottomPx: number
}

export function readSoftwareKeyboard(): SoftwareKeyboardState {
  const visual = window.visualViewport
  if (visual === null || visual === undefined) {
    return { occludedBottomPx: 0, visualBottomPx: window.innerHeight }
  }
  const visualBottomPx = visual.offsetTop + visual.height
  return {
    occludedBottomPx: Math.max(0, window.innerHeight - visualBottomPx),
    visualBottomPx,
  }
}

/**
 * Whether the software keyboard covers any of the layout viewport — the
 * question a component asks to decide whether to EXIST at all.
 *
 * Deliberately a boolean rather than the state above: the answer changes
 * twice per edit (keyboard up, keyboard down), so a subscriber re-renders
 * twice, where one that watched the edge's position would re-render on
 * every frame of every scroll. Where the edge IS belongs to
 * `trackVisualViewportBottom`, which never goes through React at all.
 */
export function useSoftwareKeyboardOccluded(): boolean {
  const [occluded, setOccluded] = useState(() => readSoftwareKeyboard().occludedBottomPx > 0)
  useEffect(() => {
    const visual = window.visualViewport
    const update = () => setOccluded(readSoftwareKeyboard().occludedBottomPx > 0)
    update()
    // resize covers the keyboard animating in and out; scroll covers iOS
    // panning its visual viewport, which can uncover the strip without a
    // resize; window resize covers rotation.
    visual?.addEventListener('resize', update)
    visual?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      visual?.removeEventListener('resize', update)
      visual?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  return occluded
}

/**
 * Calls `onBottom` with the visual viewport's bottom edge, in whole layout
 * viewport px, every time it moves — until the returned function is called.
 *
 * A per-frame READ rather than an event subscription, and that is the whole
 * point: `visualViewport`'s own `scroll` event is not delivered once per
 * frame while the viewport pans. It arrives in bursts, and iOS withholds it
 * through a momentum fling and sends one when the fling settles — so a
 * strip positioned from those events alone is left behind BETWEEN them.
 *
 * Measured as the gap between the strip and the edge it must sit on, over
 * the same 120px pan driven three ways:
 *
 * | event delivery      | positioned from events | read per frame |
 * |---------------------|------------------------|----------------|
 * | every frame (drag)  | 0px, 40/40 on the edge | 0px, 40/40     |
 * | every 5th (burst)   | 12px, 8/40             | 0px, 40/40     |
 * | none until it ends  | 117px, 1/40            | 0px, 40/40     |
 *
 * The 12px sawtooth is the judder; the 117px is the strip sitting under the
 * keyboard. Note the first row: with an event every frame the event-driven
 * path kept up perfectly, which is why this reads as intermittent rather
 * than as a position that is simply wrong.
 *
 * The caller writes the value straight to the element, and as a `transform`
 * — the one property a compositor can move without laying the page out
 * again. Whole px, because the strip carries text and icons and a
 * fractional offset renders them softened.
 */
export function trackVisualViewportBottom(onBottom: (bottomPx: number) => void): () => void {
  let previous = Number.NaN
  let frame = 0
  const tick = () => {
    const bottomPx = Math.round(readSoftwareKeyboard().visualBottomPx)
    if (bottomPx !== previous) {
      previous = bottomPx
      onBottom(bottomPx)
    }
    frame = requestAnimationFrame(tick)
  }
  // Synchronously, so a caller in `useLayoutEffect` has its position before
  // the first paint rather than one frame at the wrong place.
  tick()
  return () => cancelAnimationFrame(frame)
}
