// Deterministic, arithmetic-only measurer local to this test file's suite.
// Mirrors canvas-render's own internal `createFakeMeasure` test helper
// (that package does not publish a `test-utils` export subpath), so scene
// composition tests never depend on a real font/platform text API.
import type { FontDescriptor, MeasureText, TextMetrics } from '@kamiazya/whiteboard-canvas-render'

export function createFakeMeasure(charWidthFactor = 0.6): MeasureText {
  return (text: string, font: FontDescriptor): TextMetrics => ({
    advanceWidth: text.length * charWidthFactor * font.sizePx,
    ascent: font.sizePx * 0.8,
    descent: font.sizePx * 0.2,
    lineGap: font.sizePx * 0.1,
  })
}
