/**
 * The ONE answer to "how tall must this node be to hold its text" — the
 * editor grows a committed node to it and `wb_canvas_edit` sizes a new one
 * with it, so a box a person grows and a box an agent creates agree for the
 * same text at the same width.
 */
import type { SpatialNode } from '@kamiazya/whiteboard-model'
import type { MeasureText } from '../measure.js'
import { constantRatioMeasureText } from '../measure.js'
import type { SpatialAppearanceResolver } from '../theme/spatial-appearance.js'
import { SPATIAL_THEME_GEOMETRY } from '../theme/spatial-geometry.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { naturalNodeContentSize } from './spatial-canvas.js'

/** Metrics do not vary by UI mode, so the light theme stands for both. */
const DEFAULT_APPEARANCE = createSpatialTheme({ mode: 'light' })

/**
 * The body's laid-out height plus the node padding above and below it.
 *
 * The taller of two readings: the caller's own font, and the ratio measurer
 * every machine has. A face narrower than the ratio fits a box that still
 * reads as cut to a reader drawing the same canvas with a wider one, and to
 * the drawing score that judges it, so the floor is what makes
 * "fits" mean one thing wherever the canvas is drawn.
 *
 * Position does not matter: `naturalNodeContentSize` lays the content out
 * unbounded, so only the width it wraps against is an input.
 */
export function fittedTextNodeHeight(
  node: SpatialNode,
  options: { readonly measure: MeasureText; readonly appearance?: SpatialAppearanceResolver },
): number {
  const appearance = options.appearance ?? DEFAULT_APPEARANCE
  const under = (measure: MeasureText) => naturalNodeContentSize(node, { measure, appearance }).h
  const natural = Math.max(under(options.measure), under(constantRatioMeasureText))
  return natural + 2 * SPATIAL_THEME_GEOMETRY.paddingPx
}
