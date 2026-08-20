/**
 * A size-capped store for canvas-render's text-node body memo
 * (`SpatialLayoutOptions.contentCache`). The cap is a memory backstop, not
 * an eviction policy: a canvas re-render touches every live key, so by the
 * time the cap trips the map is dominated by keys from deleted or edited
 * nodes, and clearing costs one re-layout of content the next render
 * rebuilds anyway. Validity is the CALLER's contract — one cache per
 * measure+theme, dropped when either changes.
 */

import type { FittedBlocks, SpatialContentCache } from '@kamiazya/whiteboard-canvas-render'

const DEFAULT_MAX_ENTRIES = 2000

export function createSpatialContentCache(maxEntries = DEFAULT_MAX_ENTRIES): SpatialContentCache {
  const store = new Map<string, FittedBlocks>()
  return {
    get: (key) => store.get(key),
    set: (key, value) => {
      if (store.size >= maxEntries) store.clear()
      store.set(key, value)
    },
  }
}
