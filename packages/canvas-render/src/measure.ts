/**
 * The injected text-measurement seam. Layout is a pure function of its
 * arguments plus this callback — it never imports a font or measurer
 * itself. Composition roots supply the real implementation: opentype.js on
 * Node/Workers, `CanvasRenderingContext2D.measureText` in the browser.
 *
 * `fallbackChain` is declared here but RESOLVED by the composition-root
 * measurer; this package never picks a font.
 */
export interface FontDescriptor {
  readonly family: string
  readonly fallbackChain: readonly string[]
  /** 100-900, per the CSS font-weight numeric scale. */
  readonly weight: number
  readonly style: 'normal' | 'italic'
  /** Font size in CSS px. */
  readonly sizePx: number
}

/**
 * All fields are CSS px already scaled to `FontDescriptor.sizePx` — never
 * raw font design units. Layout treats a returned metrics object as
 * authoritative, clamping any non-finite `advanceWidth` to 0 before it can
 * reach geometry (a measurer returning a non-finite metric is a violation
 * of its contract, not something layout tries to correct further).
 */
export interface TextMetrics {
  readonly advanceWidth: number
  readonly ascent: number
  readonly descent: number
  readonly lineGap: number
}

/**
 * Layout guarantees the `text` argument never contains a newline — line
 * splitting happens before this is called.
 */
export type MeasureText = (text: string, font: FontDescriptor) => TextMetrics

/** Clamps a measurer's returned advance width to a finite, non-negative value. */
export function clampAdvance(advanceWidth: number): number {
  return Number.isFinite(advanceWidth) && advanceWidth >= 0 ? advanceWidth : 0
}

/**
 * Whether a code point occupies a full em rather than the ~half a Latin
 * letter takes: the fullwidth/CJK blocks of Unicode.
 *
 * This package never measures text itself, so this is not a measurer — it is
 * the one piece of width knowledge an ESTIMATING measurer cannot do without,
 * and it lives here because two of them exist in different packages. A
 * measurer that charges every character the same fraction is not an
 * approximation of Japanese, it is the wrong model, and the two estimators
 * disagreeing about which code points are wide would put a canvas's line
 * breaks in different places depending on which one laid it out.
 *
 * A real measurer (opentype.js, Canvas `measureText`) has no use for this:
 * it reads the advance from the font.
 */
export function isFullWidthCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x3000 && codePoint <= 0x303f) || // CJK symbols and punctuation
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // hiragana + katakana
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK extension A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK unified ideographs
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compatibility ideographs
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // fullwidth forms
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) // emoji
  )
}
