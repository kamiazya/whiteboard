/**
 * The spatial editor's `SpatialAppearanceResolver` (canvas-render's
 * `layoutSpatialCanvas` appearance seam). Deliberately ONE plain, static
 * appearance block — visual fidelity stays plain in this phase; the
 * hand-drawn look is the theme layer's job in a later phase, plugging into
 * this exact seam. This is NOT a copy of canvas-viewer's preset-color
 * resolver (`VIEWER_APPEARANCE`): that resolver derives fill from authored
 * `node.color`, which is a legitimate later enhancement here too, but is out
 * of scope for this slice.
 */
import type { SpatialAppearanceResolver } from '@kamiazya/whiteboard-canvas-render'

const CONTENT_PADDING_PX = 8
const CONTENT_FONT_SIZE_PX = 16
const CHROME_FILL = 'none'
const CHROME_STROKE = '#333333'

export const EDITOR_APPEARANCE: SpatialAppearanceResolver = {
  resolveNode: () => ({ appearance: { fill: CHROME_FILL, stroke: CHROME_STROKE } }),
  resolveEdge: () => ({ stroke: CHROME_STROKE }),
  resolveLabel: () => ({}),
  paddingPx: CONTENT_PADDING_PX,
  labelFontSizePx: CONTENT_FONT_SIZE_PX,
  minContentWidthPx: 0,
}
