import type { Viewport } from './viewport.js'

/**
 * What the canvas has selected: one primary node, the rest of a multi-node
 * selection, or one edge (an edge selection clears the node one).
 */
export interface EditorSelection {
  readonly selectedId: string | null
  readonly selectedEdgeId: string | null
  readonly extraIds: readonly string[]
}

/**
 * The read side of the selection, shaped for `useSyncExternalStore`. Kept
 * apart from the handle so a panel that only follows the selection depends
 * on this and not on the viewport verbs.
 */
export interface SelectionSource {
  getSelection(): EditorSelection
  /** Calls `listener` after the selection changes; returns the unsubscribe. */
  subscribeSelection(listener: () => void): () => void
}

/**
 * Whether the canvas draws resolved conversations, shaped for
 * `useSyncExternalStore`. Per-user view state (ADR-0025 decision 2), so it
 * lives in the editor and a panel beside it follows it from here.
 */
export interface ShowResolvedSource {
  get(): boolean
  /** Calls `listener` after the value changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}

/** Imperative surface for a page that needs to drive the viewport from
 * outside (e.g. a daemon's `viewport_request`) without owning viewport as
 * its own state. */
export interface SpatialEditorHandle {
  /** What the canvas has selected, for surfaces beside it; the mounted editor always supplies it. */
  readonly selection?: SelectionSource
  /** Whether resolved conversations are drawn; the mounted editor always supplies it. */
  readonly showResolved?: ShowResolvedSource
  setViewport(viewport: Viewport): void
  /** Draws (muted) or hides the resolved conversations on the canvas. */
  setShowResolved(show: boolean): void
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
  /**
   * Brings what a conversation is about on screen and marks it for a
   * moment — the rail's row is a list, and a list that cannot take you to
   * its subject is a dead end. Answers false when the conversation points
   * at no place on this canvas (the whole document, a passage of a note) or
   * at something no longer here, so a caller can tell "moved" from "had
   * nowhere to go". Revealing a resolved conversation also turns on
   * drawing resolved ones, so the place it lands on is not empty.
   */
  revealThread(threadId: string): boolean
}
