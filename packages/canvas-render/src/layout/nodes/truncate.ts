import type { FontDescriptor, MeasureText } from '../../measure.js'
import { clampAdvance } from '../../measure.js'

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Could this text hold a cluster at all?
 *
 * Nothing below U+0300 joins the character before it — no combining mark, no
 * regional indicator, no ZWJ, no conjoining jamo — so for text made only of
 * those, code points ARE graphemes and the cheap walk is already right. The
 * claim is checked exhaustively against the segmenter in this file's test
 * rather than reasoned about, because a joiner that slips through is a label
 * that fragments with nothing red.
 *
 * Deliberately coarse: it sends Japanese, Chinese and Korean down the
 * segmenter path even though most of their text carries no clusters. A
 * tighter gate was tried and abandoned — 'can this character join something'
 * flags every precomposed Hangul syllable, since one may follow a jamo L, so
 * it answers yes for ordinary Korean and buys nothing. Only the segmenter can
 * say whether a string HAS a cluster, which is the work being avoided.
 */
function mayCluster(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) >= 0x0300) return true
  return false
}

/**
 * The units a cut may fall between, iterated LAZILY: the walk stops at the
 * first unit that does not fit, and segmenting the tail past it is work
 * nobody reads. Measured on the 480-label bench, materialising instead cost
 * 12.1ms against 5.5ms for this.
 */
function* cutUnits(text: string): Generator<string> {
  if (!mayCluster(text)) {
    yield* text
    return
  }
  for (const { segment } of GRAPHEMES.segment(text)) yield segment
}

export interface FittedText {
  readonly text: string
  /**
   * Something was DROPPED — the returned text is a strict prefix of the
   * input. Only ever `true`, so it can be spread straight onto a
   * `TextRunNode`.
   */
  readonly truncated?: true
  /**
   * What is RETURNED is still wider than `maxWidth`: the never-empty rule
   * kept one code point that does not fit, because nothing narrower exists.
   * Only ever `true`.
   *
   * Separate from `truncated` because the two readers of "this did not fit"
   * want opposite halves of it, and each documents its own: the SVG fade and
   * `sceneDigest.truncated` mean "there is more of this than you can see",
   * while `wb_canvas_snapshot`'s `overflows` means "this does not fit its
   * box, resize it or shorten the text". A single code point too wide for
   * its box satisfies the second and not the first.
   */
  readonly overflows?: true
}

/**
 * The longest prefix of `text` that fits `maxWidth`, plus whether anything
 * was dropped and whether what came back still does not fit. Used wherever
 * the text CANNOT wrap — a node label (one line is
 * what makes it a label) and an atomic run (an interior space in a code span
 * is not a word boundary) — so cutting is the only way left to keep it inside
 * its box.
 *
 * Never returns the empty string for non-empty input: one glyph over the edge
 * still says a label is there, and nothing at all does not. That glyph is a
 * whole GRAPHEME — a lone 👨 is not a narrower family emoji, it is a
 * different picture. A non-finite or
 * non-positive `maxWidth` means "no width to fit against" and returns the
 * text unchanged, matching how layout treats an unusable wrap width
 * everywhere else.
 *
 * ponytail: linear scan, one measure per code point. Labels are short and it
 * only runs on text that already overflowed; binary-search the prefix length
 * (width is monotone in it) if a long-label case ever shows up in a profile.
 */
export function fitToWidth(
  text: string,
  font: FontDescriptor,
  measure: MeasureText,
  maxWidth: number,
): FittedText {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return { text }
  if (clampAdvance(measure(text, font).advanceWidth) <= maxWidth) return { text }
  let fitted = ''
  let firstUnit = ''
  for (const unit of cutUnits(text)) {
    if (firstUnit === '') firstUnit = unit
    const candidate = fitted + unit
    if (clampAdvance(measure(candidate, font).advanceWidth) > maxWidth) break
    fitted = candidate
  }
  const kept = fitted === '' ? firstUnit : fitted
  return {
    text: kept,
    ...(kept === text ? {} : { truncated: true as const }),
    ...(fitted === '' ? { overflows: true as const } : {}),
  }
}
