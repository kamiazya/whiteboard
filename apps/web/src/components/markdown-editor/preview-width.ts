// How wide the preview typesets, and whether the rail is affordable — both
// derived from the width the editor actually has, so a narrow phone never
// gets a document laid out wider than the pane it must fit in.
//
// Pulled out of MarkdownEditor as a pure function because the arithmetic is
// where the bug was, not the wiring: the budget ignored the padding the
// preview SVG adds to itself, and a floor meant to guarantee a readable
// measure silently guaranteed the opposite on a narrow screen.
import { PREVIEW_PADDING_PX } from './render-preview.js'

/** Horizontal padding of the document column (`px-6` on both sides). */
export const PREVIEW_COLUMN_PADDING_PX = 48

/**
 * The measure the preview would LIKE, never what it is entitled to. On a
 * container too narrow to grant it, the fit wins — see `previewWidth`.
 */
export const MIN_PREVIEW_WIDTH_PX = 320

/** Re-typeset in 64px steps so a divider drag does not relayout per pointermove. */
const QUANTUM_PX = 64

/**
 * `renderSceneToSvg` pads the preview by `PREVIEW_PADDING_PX` on EVERY side,
 * so the element that lands in the pane is `previewWidth + 2 * padding` wide.
 * Budgeting for the layout width alone left the SVG 16px wider than the box
 * it sits in, on every viewport — which is the horizontal scrollbar a phone
 * shows under content that has nowhere to go.
 */
const SVG_PADDING_PX = 2 * PREVIEW_PADDING_PX

/**
 * The width the document column is capped at, for the width the body was
 * typeset to. The other half of the same sum as `previewWidth` — kept beside
 * it because splitting the two is what let the column be 16px narrower than
 * the SVG it holds, on every viewport, for as long as the padding existed.
 */
export function previewColumnMaxWidth(width: number): number {
  return width + SVG_PADDING_PX + PREVIEW_COLUMN_PADDING_PX
}

/** The rail's own width, repeated here so the affordability sum is in one place. */
export const RAIL_WIDTH_PX = 56

/**
 * The rail is affordable once the document can still have its preferred
 * measure beside it. Below that the rail is not chrome the document can
 * spare — it is 56px taken from a column that is already at its floor, and
 * the document is what the reader came for.
 *
 * Derived rather than copied: the spatial editor's own minimap gate is 768px
 * because a centred dock and a right-inset overview collide there, which is
 * arithmetic about a different pair of things. Same PATTERN — keyed off the
 * CONTAINER, not a media query, because a narrow editor column on a wide
 * screen is just as cramped and a media query cannot see it.
 */
export const RAIL_MIN_CONTAINER_WIDTH_PX =
  MIN_PREVIEW_WIDTH_PX + PREVIEW_COLUMN_PADDING_PX + RAIL_WIDTH_PX

/**
 * Whether a container of this width can afford the rail beside the document.
 *
 * An unmeasured container answers NO, matching the spatial editor's own
 * minimap gate (its `rootSize` starts at zero, so the overview is hidden
 * until measured). A rail that appears and then vanishes on every phone load
 * is worse than one that arrives a frame late on a desktop.
 */
export function railFits(containerWidth: number | null): boolean {
  return containerWidth !== null && containerWidth >= RAIL_MIN_CONTAINER_WIDTH_PX
}

/**
 * The width the body is typeset to, given the space the pane actually has.
 *
 * The floor is a PREFERENCE clamped to the available width, not a guarantee:
 * applied unconditionally it made the document column wider than the pane on
 * any phone, and the editor answered with a horizontal scrollbar under
 * content that had nowhere to go. Quantisation rounds DOWN for the same
 * reason — rounding to nearest can land 32px past the edge on its own.
 */
export function previewWidth({
  containerWidth,
  maxWidth,
  railWidth,
  splitRatio,
  mode,
}: {
  readonly containerWidth: number | null
  readonly maxWidth: number
  readonly railWidth: number
  readonly splitRatio: number
  readonly mode: 'read' | 'write' | 'split'
}): number {
  if (containerWidth === null) return maxWidth
  const paneWidth =
    mode === 'split' ? containerWidth * (1 - splitRatio) - railWidth : containerWidth - railWidth
  const available = Math.max(0, paneWidth - PREVIEW_COLUMN_PADDING_PX - SVG_PADDING_PX)
  const quantized = Math.floor(available / QUANTUM_PX) * QUANTUM_PX
  return Math.min(maxWidth, Math.max(Math.min(MIN_PREVIEW_WIDTH_PX, available), quantized))
}
