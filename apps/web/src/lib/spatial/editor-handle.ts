import type { Viewport } from './viewport.js'

/** Imperative surface for a page that needs to drive the viewport from
 * outside (e.g. a daemon's `viewport_request`) without owning viewport as
 * its own state. */
export interface SpatialEditorHandle {
  setViewport(viewport: Viewport): void
  /** Fits the viewport to the given node ids, or to every node when omitted. */
  fitToContent(nodeIds?: readonly string[]): void
  /**
   * Brings a proposal into view and opens its card where it sits.
   *
   * The inspector's Proposals panel is an INDEX, not a second place to
   * decide (ADR-0029 decision 1: a person is never sent elsewhere to see
   * what changed), so a row hands the proposal back to the canvas rather
   * than rendering it. Answers false when the id names no proposal the
   * canvas is drawing chrome for — a caller's list can outrun the scene by
   * a frame, and moving the viewport to nowhere is worse than not moving.
   */
  openProposal(proposalId: string): boolean
}
