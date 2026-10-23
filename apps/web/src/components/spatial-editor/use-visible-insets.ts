import { type RefObject, useCallback, useLayoutEffect, useState } from 'react'
import type { ViewportOcclusion } from '../../lib/spatial/viewport.js'
import {
  currentOccluders,
  insetsFromCovers,
  onOccludersChanged,
  sameInsets,
} from '../../lib/spatial/viewport-insets.js'

export type VisibleInsets = Required<ViewportOcclusion>

const NO_INSETS: VisibleInsets = { top: 0, bottom: 0, left: 0, right: 0 }

function measure(root: HTMLElement | null): VisibleInsets {
  if (root === null) return NO_INSETS
  const covers = currentOccluders().map((element) => element.getBoundingClientRect())
  if (covers.length === 0) return NO_INSETS
  return insetsFromCovers(root.getBoundingClientRect(), covers)
}

/**
 * How much of the canvas root a panel paints over, which every viewport verb
 * (fit, zoom to selection, selection and comment reveal) treats as padding.
 *
 * `insetsOf` reads the DOM at the moment of asking, so a verb never works from
 * a measurement a frame old; `insets` is the same answer as state, there only
 * so the editor re-renders — and the keep-in-view effect runs — when a panel
 * opens, closes or changes size. A sheet's slide-in is a transform, which no
 * ResizeObserver reports, so the animation's end re-measures too.
 */
export function useVisibleInsets(rootRef: RefObject<HTMLElement | null>) {
  const [insets, setInsets] = useState<VisibleInsets>(NO_INSETS)
  const insetsOf = useCallback(() => measure(rootRef.current), [rootRef])

  useLayoutEffect(() => {
    const refresh = () => {
      const next = measure(rootRef.current)
      setInsets((prev) => (sameInsets(prev, next) ? prev : next))
    }
    let release: () => void = () => {}
    const attach = () => {
      release()
      const elements = [rootRef.current, ...currentOccluders()].filter(
        (element): element is HTMLElement => element !== null,
      )
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refresh)
      for (const element of elements) {
        observer?.observe(element)
        element.addEventListener('animationend', refresh)
        element.addEventListener('transitionend', refresh)
      }
      release = () => {
        observer?.disconnect()
        for (const element of elements) {
          element.removeEventListener('animationend', refresh)
          element.removeEventListener('transitionend', refresh)
        }
      }
      refresh()
    }
    attach()
    const unsubscribe = onOccludersChanged(attach)
    return () => {
      unsubscribe()
      release()
    }
  }, [rootRef])

  return { insets, insetsOf }
}
