import type { StrokeWidth } from '@kamiazya/whiteboard-plugin-visual'

/**
 * How many times the theme's line weight each named weight draws at.
 *
 * A multiple rather than a pixel width, so a theme that draws its lines
 * heavier draws every weight heavier and the three stay three. `thin` is 1:
 * it is the weight every line had before weights existed, and a stroke that
 * names none must draw byte-identically to how it always did. Exported so the
 * editor's draft under the pen grows by the same steps the drawn stroke will.
 */
export const STROKE_WEIGHT_FACTOR: Readonly<Record<StrokeWidth, number>> = {
  thin: 1,
  medium: 2.5,
  thick: 5,
}
