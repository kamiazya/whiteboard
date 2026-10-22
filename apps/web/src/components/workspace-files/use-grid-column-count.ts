import { useEffect, useState } from 'react'

/**
 * Reports how many columns a CSS grid is laid out in right now.
 *
 * Read from the computed `grid-template-columns` rather than derived from a
 * width and the track minimum: `auto-fill` decides the count, and a second
 * formula for it would drift from the stylesheet. Reported on every resize
 * and cleared on unmount, so a reader never keeps a count for a grid that is
 * gone.
 */
export function useGridColumnCount<T extends HTMLElement>(
  onCount: ((count: number | undefined) => void) | undefined,
): (element: T | null) => void {
  // State rather than a ref object: the grid is absent for an empty folder
  // and appears later, and only a state change re-runs the effect for it.
  const [grid, setGrid] = useState<T | null>(null)
  useEffect(() => {
    if (grid === null || onCount === undefined) return
    const report = () => {
      const tracks = getComputedStyle(grid).gridTemplateColumns.trim()
      onCount(tracks === '' || tracks === 'none' ? undefined : tracks.split(/\s+/).length)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(grid)
    return () => {
      observer.disconnect()
      onCount(undefined)
    }
  }, [grid, onCount])
  return setGrid
}
