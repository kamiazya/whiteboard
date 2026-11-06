import { type RefObject, useLayoutEffect, useState } from 'react'

/**
 * Whether a one-row strip of chrome has to fold onto a second row to show
 * every control whole.
 *
 * Answered by trying the single row rather than from a breakpoint: what fits
 * depends on how many controls the host supplied and on the pointer's control
 * size, and a width written down here goes stale the moment either changes.
 * The strip is put back to one row (`data-stacked` removed), `cramped` is
 * asked, and the attribute restored — all inside one layout pass, so the
 * single row is never painted. Re-asked whenever the strip or its container
 * changes size, which covers a resize, a pointer change and a control coming
 * or going.
 *
 * The element styles its stacked form off `data-stacked`, which the caller
 * renders from the returned flag.
 */
export function useStackWhenCramped(
  ref: RefObject<HTMLElement | null>,
  cramped: (element: HTMLElement) => boolean,
): boolean {
  const [stacked, setStacked] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = () => {
      const stackedNow = element.hasAttribute('data-stacked')
      element.removeAttribute('data-stacked')
      const answer = cramped(element)
      if (stackedNow) element.setAttribute('data-stacked', '')
      setStacked(answer)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    // Deferred a frame: the answer re-renders the strip at a new size, and
    // a change made inside the observer's own callback is a loop error.
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    })
    observer.observe(element)
    if (element.parentElement !== null) observer.observe(element.parentElement)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [ref, cramped])
  return stacked
}
