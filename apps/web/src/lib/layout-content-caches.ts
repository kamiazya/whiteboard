/**
 * The layout worker's store of canvas-render body memos, one per set of
 * axes a request can differ on.
 *
 * A store rather than a module-level map so a caller (and a test) owns its
 * own; the worker keeps exactly one for its whole life.
 *
 * Sound because the worker REFUSES to lay out until its font face is loaded,
 * so its `measure` behaves identically for every request it ever serves —
 * what a body's layout can still differ on is the UI mode, the look it is
 * drawn in, and what its text can embed. The last is compared by its bytes:
 * a different wire is a different cache.
 */

import type { SpatialContentCache, SpatialRenderStyle } from '@kamiazya/whiteboard-canvas-render'
import { createSpatialContentCache } from './content-cache.js'
import type { ResolvedTheme } from './theme.js'

export interface ContentCacheAxes {
  readonly theme: ResolvedTheme
  /**
   * The session override (ADR-0030 decision 6). Absent IS `'document'` —
   * the default the one composition both threads share takes — so a request
   * that omits it and one that spells it out keep sharing an entry.
   */
  readonly style?: SpatialRenderStyle
  /** The reference wire the entries were filled under, as its bytes. */
  readonly wireKey: string
}

/**
 * `|` separates the axes because no theme id and no UI mode can contain
 * one, so two different axis pairs cannot join into one key.
 */
function axisKey(axes: ContentCacheAxes): string {
  return `${axes.theme}|${axes.style ?? 'document'}`
}

export function createContentCacheStore(): (axes: ContentCacheAxes) => SpatialContentCache {
  const caches = new Map<string, { wireKey: string; cache: SpatialContentCache }>()
  return (axes) => {
    const key = axisKey(axes)
    const existing = caches.get(key)
    if (existing !== undefined && existing.wireKey === axes.wireKey) return existing.cache
    const cache = createSpatialContentCache()
    caches.set(key, { wireKey: axes.wireKey, cache })
    return cache
  }
}
