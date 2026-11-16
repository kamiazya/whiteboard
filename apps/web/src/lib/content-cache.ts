/**
 * A surface's content cache (`SpatialLayoutOptions.contentCache`): an object
 * the Rust core keys its own laid-out bodies by, for as long as the object
 * lives, and never reads or writes. Validity is the CALLER's contract — one
 * cache per measure+theme, dropped when either changes, which is dropping
 * this object.
 */

import type { SpatialContentCache } from '@kamiazya/whiteboard-canvas-render'

export function createSpatialContentCache(): SpatialContentCache {
  return {}
}
