import type { FontDescriptor, MeasureText, TextMetrics } from '../measure.js'

/**
 * A deterministic, purely arithmetic measurer for tests: advance width is
 * `charWidthFactor * font.sizePx` per character (monospace-like), so
 * results never depend on any real font or platform text API.
 */
export function createFakeMeasure(charWidthFactor = 0.6): MeasureText {
  return (text: string, font: FontDescriptor): TextMetrics => ({
    advanceWidth: text.length * charWidthFactor * font.sizePx,
    ascent: font.sizePx * 0.8,
    descent: font.sizePx * 0.2,
    lineGap: font.sizePx * 0.1,
  })
}
