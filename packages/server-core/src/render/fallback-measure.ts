import { isFullWidthCodePoint, type MeasureText } from '@kamiazya/whiteboard-canvas-render'

/**
 * Deterministic width estimator for the agent-facing layout tools.
 *
 * Not a real font metric — server-core is a shared layer forbidden from
 * loading fonts (architecture-map.md) — but it is SCRIPT-AWARE, which a
 * single per-character ratio is not. A kana or ideograph occupies a full em
 * where a Latin letter occupies about half of one, so charging every
 * character the same fraction is not an approximation of Japanese, it is the
 * wrong model: measured, a uniform ratio put `これは日本語です` at 56.8px
 * against a true 128px.
 *
 * That mattered because `wb_scene_digest` and `wb_scene_render` are laid out
 * with this measurer. A canvas written in Japanese came back with line breaks
 * and a `truncated` verdict computed from widths roughly half the truth — an
 * agent was told a node hid nothing while the editor showed the reader a fade.
 *
 * Node's own vendored font is NOT the answer here: it carries no CJK glyphs,
 * so `createOpentypeMeasureText` measures `あ` at 7.1px — worse than this
 * estimator, and wrong in the same direction. Replacing this with a real
 * measurer means shipping a CJK face, which is a font-distribution decision
 * rather than a layout one.
 *
 * Which code points are wide is canvas-render's `isFullWidthCodePoint`,
 * shared with `text-wrapping-corpus.ts`'s scoreboard measurer so the two
 * estimators cannot drift apart on it. The Latin ratio is this estimator's
 * own.
 */
const LATIN_WIDTH_FACTOR = 0.55

export const fallbackMeasureText: MeasureText = (text, font) => {
  let em = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0)
    em += codePoint !== undefined && isFullWidthCodePoint(codePoint) ? 1 : LATIN_WIDTH_FACTOR
  }
  return {
    advanceWidth: em * font.sizePx,
    ascent: font.sizePx * 0.8,
    descent: font.sizePx * 0.2,
    lineGap: font.sizePx * 0.1,
  }
}
