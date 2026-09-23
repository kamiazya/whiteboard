import type { MarkdownViewMode } from './EditorToolbar.js'
import { previewWidth as computePreviewWidth, RAIL_WIDTH_PX, railFits } from './preview-width.js'

/** Below this container width the split cannot hold two readable columns. */
const SPLIT_MIN_WIDTH = 640

export interface EditorLayout {
  /** Whether the container can hold two columns at all. */
  readonly splitAvailable: boolean
  /**
   * The mode the editor actually RENDERS, which is the requested one unless
   * the container is too narrow for it. `split` falls back to `write` rather
   * than to `read`, because the user asked to edit.
   */
  readonly effectiveMode: MarkdownViewMode
  /** Whether the container has room for the minimap rail beside the panes. */
  readonly railAffordable: boolean
  /** The width the rail claims — zero where it is not drawn at all. */
  readonly railWidth: number
  /** What is left for the preview column once the rail has taken its share. */
  readonly previewWidth: number
}

/**
 * Everything the container's WIDTH decides.
 *
 * One function because it is one question asked five times — whether there
 * is room — and the answers depend on each other: the rail's width feeds the
 * preview's, and the effective mode feeds the rail's. Spread through the
 * component as five separate `const`s, each with its own condition, the
 * order they had to be read in was invisible.
 */
export function editorLayout({
  containerWidth,
  mode,
  maxWidth,
  splitRatio,
  hasContent,
}: {
  containerWidth: number | null
  mode: MarkdownViewMode
  maxWidth: number
  splitRatio: number
  hasContent: boolean
}): EditorLayout {
  // `null` — pre-observation, or jsdom without ResizeObserver — is treated
  // as wide, which is the split-by-default contract.
  const splitAvailable = containerWidth === null || containerWidth >= SPLIT_MIN_WIDTH
  const effectiveMode: MarkdownViewMode = mode === 'split' && !splitAvailable ? 'write' : mode
  const railAffordable = railFits(containerWidth)
  const railWidth = railAffordable && effectiveMode !== 'write' && hasContent ? RAIL_WIDTH_PX : 0
  return {
    splitAvailable,
    effectiveMode,
    railAffordable,
    railWidth,
    previewWidth: computePreviewWidth({
      containerWidth,
      maxWidth,
      railWidth,
      splitRatio,
      mode: effectiveMode,
    }),
  }
}
