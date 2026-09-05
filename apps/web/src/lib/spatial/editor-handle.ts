import type { Viewport } from './viewport.js'

/** Imperative surface for a page that needs to drive the viewport from
 * outside (e.g. a daemon's `viewport_request`) without owning viewport as
 * its own state. */
export interface SpatialEditorHandle {
  setViewport(viewport: Viewport): void
  /** Fits the viewport to the given node ids, or to every node when omitted. */
  fitToContent(nodeIds?: readonly string[]): void
}
