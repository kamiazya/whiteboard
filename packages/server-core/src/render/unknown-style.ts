import { resolveThemeTable, type SpatialRenderStyle } from '@kamiazya/whiteboard-canvas-render'
import { visualRenderContribution } from '@kamiazya/whiteboard-plugin-visual/render'

// The ids a layout can draw, read from the table the layout itself resolves
// (`composeCanvasScene` passes no contributions, so it falls back to the same
// one) — so a style is refused exactly when drawing it would have degraded.
const DRAWABLE_THEME_IDS: readonly string[] = Object.keys(
  resolveThemeTable([visualRenderContribution]),
)

/**
 * Why a caller's `style` cannot be drawn, or `undefined` when it can.
 *
 * `'clean'` and `'document'` always draw. A theme id nothing registered would
 * draw the clean look and answer success, so a typo was indistinguishable from
 * the theme the caller asked for; the write path already refuses the same id
 * with the registered ones (`wb_facet_set`), and a read says the same thing.
 */
export function unknownStyleRefusal(style: SpatialRenderStyle | undefined): string | undefined {
  if (style === undefined || style === 'clean' || style === 'document') return undefined
  if (DRAWABLE_THEME_IDS.includes(style)) return undefined
  return `no theme "${style}" is registered — registered: ${DRAWABLE_THEME_IDS.join(', ')}; or pass style "clean" or "document"`
}
