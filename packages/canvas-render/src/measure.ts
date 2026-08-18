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
 * Ratios of an em box for a rough Latin sans-serif face. Not any real
 * font's metrics — see `constantRatioMeasureText`.
 */
const RATIO_ADVANCE = 0.55
const RATIO_ASCENT = 0.75
const RATIO_DESCENT = 0.25
const RATIO_LINE_GAP = 0.1

function clampNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * The measurer of last resort: what a caller uses when no real one is
 * reachable — the export font asset failed to load, the realm has no
 * Canvas 2D context (jsdom), or the layer is forbidden from loading a font
 * at all (server-core).
 *
 * It lives here, in the package that DEFINES `MeasureText`, because every
 * one of those callers needs the same thing: a deterministic estimate that
 * satisfies the contract (finite, non-negative, `advanceWidth('') === 0`,
 * linear in `sizePx`). Three composition roots grew their own copy with
 * three different constant sets, so the same canvas measured differently
 * depending on which degraded path produced it — the numbers are arbitrary,
 * but they must be arbitrary in ONE way.
 *
 * Its output matches no real font, and that is the point: a scene laid out
 * with it is degraded, never byte-reproducible against a measured one.
 */
export const constantRatioMeasureText: MeasureText = (text, font) => {
  const sizePx = clampNonNegative(font.sizePx)
  return {
    advanceWidth: clampNonNegative(text.length * sizePx * RATIO_ADVANCE),
    ascent: sizePx * RATIO_ASCENT,
    descent: sizePx * RATIO_DESCENT,
    lineGap: sizePx * RATIO_LINE_GAP,
  }
}
