import { useEffect } from 'react'
import {
  applyFavicon,
  type FaviconRect,
  type FaviconStatus,
  type FaviconStyle,
  renderFavicon,
} from '../lib/favicon.js'

/**
 * Keeps the tab favicon in sync with the canvas page: status dot (saved /
 * unsaved / syncing / offline) plus, in 'minimap' style, an abstract map of
 * the scene's node boxes. Debounced so a continuous drag repaints the icon
 * once it settles, not per pointer move; unmount restores the static icon.
 * Where canvas 2D is unavailable (jsdom), renderFavicon returns null and
 * the static icon stays.
 */
export function useFavicon({
  style,
  status,
  rects,
}: {
  style: FaviconStyle
  status: FaviconStatus
  rects: readonly FaviconRect[]
}): void {
  useEffect(() => {
    const id = setTimeout(() => {
      const url = renderFavicon({ style, status, rects })
      if (url !== null) applyFavicon(url)
    }, 150)
    return () => clearTimeout(id)
  }, [style, status, rects])

  useEffect(() => () => applyFavicon(null), [])
}
