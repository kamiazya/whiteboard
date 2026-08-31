import type { FontDescriptor, MeasureText } from '../../measure.js'
import { clampAdvance } from '../../measure.js'

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
 * still says a label is there, and nothing at all does not. A non-finite or
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
  const points = [...text]
  let fitted = ''
  for (const point of points) {
    const candidate = fitted + point
    if (clampAdvance(measure(candidate, font).advanceWidth) > maxWidth) break
    fitted = candidate
  }
  const kept = fitted === '' ? (points[0] ?? '') : fitted
  return {
    text: kept,
    ...(kept === text ? {} : { truncated: true as const }),
    ...(fitted === '' ? { overflows: true as const } : {}),
  }
}
