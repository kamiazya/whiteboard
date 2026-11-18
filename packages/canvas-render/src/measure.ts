/**
 * The injected text-measurement seam. Layout is a pure function of its
 * arguments plus this callback — it never imports a font or measurer
 * itself. Composition roots supply the real implementation: opentype.js on
 * Node/Workers, `CanvasRenderingContext2D.measureText` in the browser.
 *
 * `fallbackChain` is declared here but RESOLVED by the composition-root
 * measurer; this package never picks a font.
 *
 * What the two real measurers owe each other beyond this signature —
 * unkerned, unhinted design advances, so `advance(a + b)` equals
 * `advance(a) + advance(b)` — is `describeMeasureTextConformance`
 * (`test-utils`), run against each of them.
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
 *
 * Degraded is not the same as arbitrary, though, which is why it is
 * script-aware (`isFullWidthCodePoint`). One ratio for every character is
 * not a coarse estimate of Japanese, it is the wrong shape: a kana occupies
 * a full em where an `i` occupies a fraction of one, so a uniform ratio
 * understates a Japanese line by roughly half however the constant is
 * tuned. Counting code points rather than UTF-16 units falls out of the
 * same loop, and stops an astral code point being charged twice.
 */
export const constantRatioMeasureText: MeasureText = (text, font) => {
  const sizePx = clampNonNegative(font.sizePx)
  let em = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0)
    em += codePoint !== undefined && isFullWidthCodePoint(codePoint) ? 1 : RATIO_ADVANCE
  }
  return {
    advanceWidth: clampNonNegative(em * sizePx),
    ascent: sizePx * RATIO_ASCENT,
    descent: sizePx * RATIO_DESCENT,
    lineGap: sizePx * RATIO_LINE_GAP,
  }
}

/**
 * A measurer named as data, so the Rust core can measure as it does
 * (ADR-0054 step 7): the deterministic test measurer at its factor, the
 * ratio estimate above, a font-table measurer over these faces' bytes, or
 * the measurer itself, which the core asks mid-layout through its one host
 * import (the browser's canvas context, which no table of font bytes
 * repeats). A layout naming `host` hands the core its `measure` beside the
 * request.
 */
export type MeasureSpec =
  | { readonly kind: 'fake'; readonly factor: number }
  | { readonly kind: 'ratio' }
  | { readonly kind: 'host' }
  | {
      readonly kind: 'fonts'
      readonly faces: readonly {
        readonly family: string
        readonly bold: boolean
        readonly italic: boolean
        readonly bytes: Uint8Array
      }[]
    }

const SPECS = new WeakMap<MeasureText, MeasureSpec>()

/**
 * Names `measure` as `spec`, for the measurer's own maker to call. Naming is
 * what lets the core measure as the function does without asking it — the
 * only way a layout off the host's thread (a worker, the core's own query
 * entry) can repeat it — and what keeps a body the core laid out with one
 * named measurer reusable by the next layout naming the same spec.
 */
export function describeMeasure(measure: MeasureText, spec: MeasureSpec): MeasureText {
  SPECS.set(measure, spec)
  return measure
}

const HOST: MeasureSpec = { kind: 'host' }

/**
 * What `measure` was named as; a measurer nobody named is `host`, so the core
 * asks the function itself, mid-layout. There is no layout behind the core to
 * answer for one it cannot repeat, and a host measurer is one any function is.
 */
export function measureSpecOf(measure: MeasureText): MeasureSpec {
  return SPECS.get(measure) ?? HOST
}

describeMeasure(constantRatioMeasureText, { kind: 'ratio' })
