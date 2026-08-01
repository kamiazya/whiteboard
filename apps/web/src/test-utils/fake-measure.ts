import type { FontDescriptor, TextMetrics } from '@kamiazya/whiteboard-canvas-render'

/**
 * Deterministic, ratio-based `MeasureText` for tests where geometry is not
 * the concern (that belongs to a `.browser.test.tsx` using a real Canvas 2D
 * context). Mirrors the fallback in `packages/canvas-viewer/src/measure-text.ts`
 * so tests exercise the same shape of `TextMetrics` contract.
 */
export function fakeMeasure(text: string, font: FontDescriptor): TextMetrics {
  if (text === '') return { advanceWidth: 0, ascent: 0, descent: 0, lineGap: 0 }
  return {
    advanceWidth: text.length * font.sizePx * 0.6,
    ascent: font.sizePx * 0.8,
    descent: font.sizePx * 0.2,
    lineGap: 0,
  }
}
