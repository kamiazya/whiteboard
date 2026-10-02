import type { FontDescriptor, TextMetrics } from '@kamiazya/whiteboard-canvas-render'

/**
 * Deterministic, ratio-based `MeasureText` for tests where geometry is not
 * the concern (that belongs to a `.browser.test.tsx` using a real Canvas 2D
 * context). A test that wants canvas-render's own measurers imports them from
 * `@kamiazya/whiteboard-canvas-render/test-utils`; this one differs from
 * `createFakeMeasure` in its line gap (none) and in measuring a blank string
 * as zero-sized, so moving its callers over means re-deriving their numbers.
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
