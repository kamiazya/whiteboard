/**
 * React seam for the keyed SVG patcher: a ref callback that mounts once
 * and patches on every `keyed` change. React owns the CONTAINER element
 * and nothing below it — the hook renders no children through React, so a
 * parent re-render can never clobber a patched subtree the way a
 * `dangerouslySetInnerHTML` prop swap would. This is the imperative-
 * container pattern (the same shape as embedding a map library), chosen
 * so the patcher's DOM continuity survives React's render cycle.
 */

import type { KeyedSvgRender } from '@kamiazya/whiteboard-canvas-render'
import { useCallback, useLayoutEffect, useRef } from 'react'
import { type KeyedSvgPatcher, mountKeyedSvg } from './keyed-svg-patcher'

export function useKeyedSvg(keyed: KeyedSvgRender): (container: HTMLElement | null) => void {
  const containerRef = useRef<HTMLElement | null>(null)
  const patcherRef = useRef<KeyedSvgPatcher | null>(null)

  // Layout-effect timing: the patch lands before paint, in the same frame
  // as the React commit that carried the new render — the innerHTML swap
  // this replaces had the same timing.
  useLayoutEffect(() => {
    const container = containerRef.current
    if (container === null) return
    if (patcherRef.current === null) {
      patcherRef.current = mountKeyedSvg(container, keyed)
    } else {
      patcherRef.current.update(keyed)
    }
  }, [keyed])

  return useCallback((container: HTMLElement | null) => {
    if (container === containerRef.current) return
    containerRef.current = container
    // A detached or swapped container invalidates the mounted patcher; the
    // next layout effect re-mounts into the new one. (StrictMode's dev
    // double-mount re-runs the mount path idempotently.)
    patcherRef.current = null
    if (container !== null) container.replaceChildren()
  }, [])
}
