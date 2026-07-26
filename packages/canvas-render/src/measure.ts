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
