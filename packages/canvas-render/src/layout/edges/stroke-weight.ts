import { resolveStrokeWidth, type StrokeWidth } from '@kamiazya/whiteboard-plugin-visual'
import type { Appearance, RoutableElement } from '@kamiazya/whiteboard-scene'

/**
 * How many times the theme's line weight each named weight draws at.
 *
 * A multiple rather than a pixel width, so a theme that draws its lines
 * heavier draws every weight heavier and the three stay three. `thin` is 1:
 * it is the weight every line had before weights existed, and a stroke that
 * names none must draw byte-identically to how it always did.
 */
const WEIGHT_FACTOR: Readonly<Record<StrokeWidth, number>> = { thin: 1, medium: 2.5, thick: 5 }

/**
 * SVG's initial `stroke-width`, which is what an edge whose theme names no
 * weight is drawn at — the bundled look sets none.
 */
const SVG_INITIAL_STROKE_WIDTH = 1

/** The element's appearance with its own stroke weight applied. */
export function weighStroke(
  appearance: Appearance | undefined,
  element: RoutableElement,
): Appearance | undefined {
  const factor = WEIGHT_FACTOR[resolveStrokeWidth(element)]
  if (factor === 1) return appearance
  const base = appearance?.strokeWidth ?? SVG_INITIAL_STROKE_WIDTH
  return { ...appearance, strokeWidth: base * factor }
}
