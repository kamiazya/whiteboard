/**
 * Where the software keyboard is, read from the signals the platform gives
 * a page — and there are two, because browsers make room for the keyboard
 * in two different ways.
 *
 * With `interactive-widget=resizes-content` (index.html; Chrome 108+ and
 * Firefox 132+) the LAYOUT viewport shrinks, so a strip at `bottom: 0` is
 * already on the keyboard's edge and the browser holds it there.
 *
 * WebKit has not implemented that key, so on iOS the keyboard overlays the
 * page: `innerHeight` stays put while `visualViewport.height` shrinks, and
 * the page has to lift the strip itself. Apple made that choice
 * deliberately — resizing the layout viewport was judged too expensive — so
 * it is a design, not a gap that will close on its own.
 */

/** How far above the window's bottom edge a keyboard-docked strip belongs. */
export function keyboardLiftPx(): number {
  const visual = window.visualViewport
  if (visual === null || visual === undefined) return 0
  // Zero whenever the layout viewport already tracks the keyboard, which is
  // what makes one formula serve both worlds: `bottom: 0` plus this lift is
  // correct in each, and on the engines that resize the content the lift
  // never changes, so nothing is written per frame at all.
  return Math.max(0, Math.round(window.innerHeight - (visual.offsetTop + visual.height)))
}

/** Where a keyboard-docked strip sits, and whether it should be showing. */
export interface KeyboardDock {
  readonly liftPx: number
  /**
   * False while the visual viewport is still panning. Only iOS ever reports
   * this, because only there does the viewport pan under the page at all.
   */
  readonly settled: boolean
}

/**
 * How long the visual viewport must hold still before a strip that follows
 * it is worth showing again. Long enough to cover the gaps between iOS's
 * bursts of scroll events, short enough that a scroll-and-stop feels like
 * the strip came back rather than had to be waited for.
 */
const SETTLE_MS = 150

/**
 * Calls `onChange` whenever the dock moves or its settled state flips, until
 * the returned function is called.
 *
 * A per-frame READ rather than an event subscription, and that is the whole
 * point on the fallback path: `visualViewport`'s own `scroll` event is not
 * delivered once per frame while the viewport pans. It arrives in bursts,
 * and iOS withholds it through a momentum fling and sends one when the fling
 * settles, so a strip positioned from those events alone is left behind
 * BETWEEN them.
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
 * Reading per frame is still not enough on a real fling, and cannot be:
 * iOS pans the visual viewport on the compositor, so `offsetTop` read on the
 * main thread is itself behind. That is why the dock also reports whether
 * the viewport has stopped — a strip trailing its edge reads as broken,
 * where a strip that steps aside for the scroll and returns reads as
 * deliberate. On an engine that resizes the content there is no pan, so
 * `settled` is never false and none of this is reachable.
 *
 * The caller writes the values straight to the element, and the position as
 * a `transform` — the one property a compositor can move without laying the
 * page out again. Whole px, because the strip carries text and icons and a
 * fractional offset renders them softened.
 */
export function trackKeyboardDock(onChange: (dock: KeyboardDock) => void): () => void {
  let previous: KeyboardDock | null = null
  let lastOffsetTop = window.visualViewport?.offsetTop ?? 0
  let lastPanAt = Number.NEGATIVE_INFINITY
  let frame = 0
  const tick = () => {
    const now = performance.now()
    const offsetTop = window.visualViewport?.offsetTop ?? 0
    if (offsetTop !== lastOffsetTop) {
      lastOffsetTop = offsetTop
      lastPanAt = now
    }
    const next: KeyboardDock = {
      liftPx: keyboardLiftPx(),
      settled: now - lastPanAt >= SETTLE_MS,
    }
    if (previous === null || next.liftPx !== previous.liftPx || next.settled !== previous.settled) {
      previous = next
      onChange(next)
    }
    frame = requestAnimationFrame(tick)
  }
  // Synchronously, so a caller in `useLayoutEffect` has its position before
  // the first paint rather than one frame at the wrong place.
  tick()
  return () => cancelAnimationFrame(frame)
}
