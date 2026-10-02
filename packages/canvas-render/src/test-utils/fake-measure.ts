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

export interface FixedMeasureSpec {
  /** A number is the width of every string; a function derives it from the text. */
  readonly advance: number | ((text: string) => number)
  readonly ascent: number
  readonly descent: number
  readonly lineGap?: number
}

/**
 * A measurer whose answer does not scale with the font, for a test whose
 * assertions are written in the numbers it chose (a width of 30, an 8px
 * advance per character) rather than in ratios of `font.sizePx`.
 */
export function createFixedMeasure(spec: FixedMeasureSpec): MeasureText {
  const { advance, ascent, descent, lineGap = 0 } = spec
  return (text: string): TextMetrics => ({
    advanceWidth: typeof advance === 'number' ? advance : advance(text),
    ascent,
    descent,
    lineGap,
  })
}
