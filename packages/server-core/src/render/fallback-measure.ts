import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'

/**
 * Deterministic average-character-width estimator. Not a real font metric —
 * server-core is a shared layer forbidden from loading fonts
 * (architecture-map.md) — just enough to produce stable, finite bounding
 * boxes for the render/digest tools until a composition root injects a
 * real measurer via a future ServerDeps extension.
 */
const AVERAGE_CHAR_WIDTH_FACTOR = 0.55

export const fallbackMeasureText: MeasureText = (text, font) => ({
  advanceWidth: text.length * AVERAGE_CHAR_WIDTH_FACTOR * font.sizePx,
  ascent: font.sizePx * 0.8,
  descent: font.sizePx * 0.2,
  lineGap: font.sizePx * 0.1,
})
