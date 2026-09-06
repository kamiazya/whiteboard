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

export function useKeyedSvg(
  keyed: KeyedSvgRender,
  /**
   * Which pipeline produced `keyed`. A host that swaps between two of them
   * — the editor patches this same container to the drag BACKDROP for the
   * length of a gesture — passes a different token for each, and the update
   * that crosses the boundary is then told it is not a document change.
   *
   * Without it a grabbed comment pin reaches the patcher as a removal and
   * fades out at the anchor the pointer just left, under the preview that
   * is carrying it.
   */
  source?: string,
): (container: HTMLElement | null) => void {
  const containerRef = useRef<HTMLElement | null>(null)
  const patcherRef = useRef<KeyedSvgPatcher | null>(null)
  const sourceRef = useRef(source)

  // Layout-effect timing: the patch lands before paint, in the same frame
  // as the React commit that carried the new render — the innerHTML swap
  // this replaces had the same timing.
  useLayoutEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const swapped = sourceRef.current !== source
    sourceRef.current = source
    if (patcherRef.current === null) {
      patcherRef.current = mountKeyedSvg(container, keyed)
    } else {
      patcherRef.current.update(keyed, swapped ? { animate: false } : undefined)
    }
  }, [keyed, source])

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
