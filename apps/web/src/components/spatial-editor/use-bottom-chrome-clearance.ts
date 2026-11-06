import { type RefObject, useLayoutEffect, useRef, useState } from 'react'

/** Room kept between a piece of chrome and the bottom chrome it stands clear of. */
const CHROME_CLEARANCE_PX = 8

/** The lift clearing every rect in `chrome` that reaches under `mine`'s column, from `floor`. */
function clearance(mine: DOMRect, chrome: readonly DOMRect[], floor: number): number | undefined {
  let needed: number | undefined
  for (const its of chrome) {
    const under =
      its.width > 0 && its.right + CHROME_CLEARANCE_PX > mine.left && its.left < mine.right
    if (!under) continue
    const above = floor - its.top + CHROME_CLEARANCE_PX
    needed = needed === undefined ? above : Math.max(needed, above)
  }
  return needed
}

/** Re-measures on every change that can move the chrome: its size, the set of
 *  elements, and (viewport scope) the window. Coalesced to one measure a frame
 *  for the subtree watch, which fires for every mutation deep in a page. */
function watchBottomChrome(
  root: HTMLElement,
  own: HTMLElement,
  below: string,
  scope: 'parent' | 'viewport',
  onChrome: (chrome: HTMLElement[]) => void,
): () => void {
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure())
  const measure = () => {
    const chrome = [...root.querySelectorAll<HTMLElement>(below)].filter((el) => el !== own)
    for (const el of chrome) resize?.observe(el)
    onChrome(chrome)
  }
  measure()
  resize?.observe(own)
  let frame = 0
  const schedule = () => {
    if (frame !== 0) return
    frame = requestAnimationFrame(() => {
      frame = 0
      measure()
    })
  }
  // Bottom chrome comes and goes (the Draw options with the tool, the
  // overview with its toggle), and a new element is nothing a
  // ResizeObserver already watching would report.
  const mutations =
    typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(scope === 'viewport' ? schedule : measure)
  mutations?.observe(root, { childList: true, subtree: scope === 'viewport' })
  if (scope === 'viewport') window.addEventListener('resize', schedule)
  return () => {
    resize?.disconnect()
    mutations?.disconnect()
    if (frame !== 0) cancelAnimationFrame(frame)
    if (scope === 'viewport') window.removeEventListener('resize', schedule)
  }
}

/**
 * How high a piece of bottom-anchored chrome must stand, measured from the
 * editor's bottom edge, to clear whatever chrome matched by `below` reaches
 * under its column — undefined when nothing does, so its class's own offset
 * holds.
 *
 * Measured rather than derived from a breakpoint: the dock is as wide and as
 * tall as its controls add up to on this pointer — one row or two — and a
 * fixed figure went stale the moment a tool was added. Only the horizontal
 * spans decide whether something reaches under, so standing higher does not
 * undo the answer that lifted it.
 *
 * The chrome is looked up inside the element's own parent, the editor root —
 * or, with `scope: 'viewport'`, anywhere in the document against the
 * viewport's bottom edge, for a control fixed to the screen rather than placed
 * in the editor (the shell's exit-fullscreen button).
 */
export function useBottomChromeClearance<E extends HTMLElement>(
  active: boolean,
  below: string,
  scope: 'parent' | 'viewport' = 'parent',
): readonly [RefObject<E | null>, number | undefined] {
  const surface = useRef<E>(null)
  const [lift, setLift] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const own = surface.current
    const root = scope === 'viewport' ? document.body : own?.parentElement
    if (!active || own === null || own === undefined || root === null || root === undefined) {
      setLift(undefined)
      return
    }
    const floor = () =>
      scope === 'viewport' ? window.innerHeight : root.getBoundingClientRect().bottom
    return watchBottomChrome(root, own, below, scope, (chrome) =>
      setLift(
        clearance(
          own.getBoundingClientRect(),
          chrome.map((el) => el.getBoundingClientRect()),
          floor(),
        ),
      ),
    )
  }, [active, below, scope])
  return [surface, lift]
}
