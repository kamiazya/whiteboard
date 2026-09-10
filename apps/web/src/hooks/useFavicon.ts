import type { VisualSymbolFacet } from '@kamiazya/whiteboard-plugin-visual'
import { useEffect } from 'react'
import { updateAppBadge } from '../lib/app-badge.js'
import {
  applyFavicon,
  type FaviconRect,
  type FaviconStatus,
  type FaviconStyle,
  renderFavicon,
} from '../lib/favicon.js'

/**
 * Keeps the tab favicon in sync with the canvas page: status dot (saved /
 * unsaved / syncing / offline) plus the mark — the document's own symbol
 * when it has one, else, in 'minimap' style, an abstract map of the scene's
 * node boxes. Debounced so a continuous drag repaints the icon
 * once it settles, not per pointer move; unmount restores the static icon.
 * Where canvas 2D is unavailable (jsdom), renderFavicon returns null and
 * the static icon stays.
 */
export function useFavicon({
  style,
  status,
  rects,
  symbol,
}: {
  style: FaviconStyle
  status: FaviconStatus
  rects: readonly FaviconRect[]
  symbol?: VisualSymbolFacet
}): void {
  useEffect(() => {
    const id = setTimeout(() => {
      const url = renderFavicon({ style, status, rects, symbol })
      if (url !== null) applyFavicon(url)
    }, 150)
    return () => clearTimeout(id)
  }, [style, status, rects, symbol])

  // The installed app's icon mirrors the same status (Badging API).
  useEffect(() => {
    updateAppBadge(status)
  }, [status])

  useEffect(
    () => () => {
      applyFavicon(null)
      updateAppBadge('quiet')
    },
    [],
  )
}
