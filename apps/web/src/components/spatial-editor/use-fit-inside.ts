import { type RefObject, useCallback, useLayoutEffect, useState } from 'react'

/** Screen px kept between a card and the root's edge once slid inside. */
const CARD_EDGE_MARGIN_PX = 8

const NO_SLIDE = { x: 0, y: 0 } as const

/**
 * How far a floating card has to slide back so it sits inside the root it is
 * positioned in, as a (<= 0) offset to add to its natural `at.x` / `at.y`.
 *
 * The root clips, so a card hanging past an edge puts its controls where no
 * finger can reach them. Sliding rather than panning the canvas keeps the
 * surface still under a reader who only opened something; the layout effect
 * corrects before paint, so there is no visible jump.
 *
 * It re-fits whenever the card's OWN size changes, not only when it is placed:
 * a card's height is not known at the first measure (a body is laid out once a
 * ResizeObserver has reported its width, a composer is a CodeMirror view made
 * in an effect, a disclosure adds rows), and a one-shot measure slides it by a
 * height it no longer has. There is no feedback loop — the correction moves
 * the card, it does not resize it. `content` is whatever the caller renders
 * that can change that size, so a runtime without ResizeObserver still
 * re-measures on it.
 */
export function useFitInside(
  ref: RefObject<HTMLElement | null>,
  at: { readonly x: number; readonly y: number; readonly width: number },
  content: unknown,
): { readonly x: number; readonly y: number } {
  const [slide, setSlide] = useState<{ readonly x: number; readonly y: number }>(NO_SLIDE)
  const { x, y, width } = at
  const fit = useCallback(() => {
    const el = ref.current
    const parent = el?.offsetParent
    if (el == null || !(parent instanceof HTMLElement)) return
    // The card is placed by left/top, so its box is the same with any slide
    // applied and the correction is always taken from its natural place.
    // Ceil the measured box: a fractional size would overshoot the margin by
    // a subpixel.
    const rect = el.getBoundingClientRect()
    const next = {
      x: Math.min(0, parent.clientWidth - CARD_EDGE_MARGIN_PX - (x + Math.ceil(rect.width))),
      y: Math.min(0, parent.clientHeight - CARD_EDGE_MARGIN_PX - (y + Math.ceil(rect.height))),
    }
    setSlide((prev) => (prev.x === next.x && prev.y === next.y ? prev : next))
  }, [ref, x, y])
  useLayoutEffect(fit, [fit, width, content])

  useLayoutEffect(() => {
    const el = ref.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, fit])

  return slide
}
