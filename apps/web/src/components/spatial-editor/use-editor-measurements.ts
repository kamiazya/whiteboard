import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import type { ContainerSize, Point } from './viewport.js'

/**
 * Below this root width the minimap is noise rather than orientation, and
 * the inspector renders as a bottom sheet rather than a docked column.
 */
export const MINIMAP_MIN_ROOT_WIDTH_PX = 768

export interface EditorMeasurements {
  shellRef: RefObject<HTMLDivElement | null>
  /** The canvas root's own pixel size, for the minimap's visible-area marker. */
  rootSize: { width: number; height: number }
  shellWidth: number
  inspectorIsSheet: boolean
  /** Root-local screen point at the middle of the visible canvas. */
  viewportCenterScreen: () => Point
  containerSizeOf: (root: HTMLDivElement | null) => ContainerSize | null
}

/**
 * The editor's measured geometry, in one place.
 *
 * `rootSize` is a ResizeObserver rather than a window `resize` listener,
 * because the container resizes without the window doing so — a side panel
 * opening, the browser chrome changing height on mobile — and a marker that
 * lags those is wrong about where you are. Guarded because jsdom has no
 * ResizeObserver: without the guard every jsdom test that mounts the editor
 * would throw. There it measures once and stays there, which is correct for
 * a layout that never changes.
 *
 * `shellWidth` is the SHELL's width, not the canvas's. The inspector takes a
 * column out of the canvas, so `rootSize` shrinks when it opens — and a
 * breakpoint read off `rootSize` then flips as a CONSEQUENCE of its own
 * decision. Measured: opening the dock on a 900px editor left the canvas at
 * 548, below the 768 breakpoint, so the panel re-rendered as a bottom sheet
 * spanning the full width.
 */
export function useEditorMeasurements(
  rootRef: RefObject<HTMLDivElement | null>,
): EditorMeasurements {
  const [rootSize, setRootSize] = useState({ width: 0, height: 0 })
  const shellRef = useRef<HTMLDivElement | null>(null)
  const [shellWidth, setShellWidth] = useState(0)

  useLayoutEffect(() => {
    const shell = shellRef.current
    if (shell === null) return
    const measure = () => {
      setShellWidth((prev) => (prev === shell.clientWidth ? prev : shell.clientWidth))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(shell)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const measure = () => {
      setRootSize((prev) =>
        prev.width === root.clientWidth && prev.height === root.clientHeight
          ? prev
          : { width: root.clientWidth, height: root.clientHeight },
      )
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [rootRef])

  const inspectorIsSheet = shellWidth > 0 && shellWidth < MINIMAP_MIN_ROOT_WIDTH_PX

  const viewportCenterScreen = (): Point => {
    const root = rootRef.current
    return root === null ? { x: 0, y: 0 } : { x: root.clientWidth / 2, y: root.clientHeight / 2 }
  }

  const containerSizeOf = (root: HTMLDivElement | null): ContainerSize | null =>
    root === null ? null : { width: root.clientWidth, height: root.clientHeight }

  return { shellRef, rootSize, shellWidth, inspectorIsSheet, viewportCenterScreen, containerSizeOf }
}
