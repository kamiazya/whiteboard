/**
 * What search compares: text lowercased and, for Latin script, with its
 * diacritics folded away, so "cafe" finds "Café" and "equipe" finds
 * "Équipe" — nobody types the accent a name happens to carry.
 *
 * Folding is per code point, which is what lets a match in the folded text
 * be mapped back onto the ORIGINAL: an excerpt quotes, and a highlight
 * marks, what the document actually says.
 *
 * Only marks that sit on a Latin letter are dropped. A dakuten is a
 * combining mark under NFKD too, and stripping it would make が and か one
 * character; CJK and kana are left exactly as written, and so is every
 * other script, whose marks are often letters in their own right (й is not
 * a decorated и to a Russian reader). A compatibility form whose
 * decomposition is Latin or ASCII — a ligature, a fullwidth letter, a
 * circled digit — folds to that decomposition.
 */

const MARK = /\p{M}/u
const LATIN = /\p{Script=Latin}/u
const ASCII = /^[\x20-\x7e]+$/

const ALL_ASCII = /^\p{ASCII}*$/u

export interface Folded {
  readonly text: string
  /** Where the source of `text`'s code unit `i` starts in the original. */
  readonly startOf: (i: number) => number
  /** Where that source ends — any marks folded into it included. */
  readonly endOf: (i: number) => number
}

interface FoldedCodePoint {
  readonly out: string
  readonly latin: boolean
}

/**
 * Folding a code point asks the runtime to lowercase and normalise it, which
 * is the whole cost of indexing a non-ASCII body; a document repeats a small
 * alphabet, so each answer is remembered. Bounded, so a body of distinct
 * ideographs cannot grow it without limit.
 */
const FOLDED_MAX = 4096
const foldedCodePoints = new Map<string, FoldedCodePoint>()

const ASCII_LOWER: readonly FoldedCodePoint[] = Array.from({ length: 0x80 }, (_, unit) => ({
  out: String.fromCharCode(unit).toLowerCase(),
  latin: /[A-Za-z]/.test(String.fromCharCode(unit)),
}))

/**
 * Kana, CJK ideographs and Hangul syllables have no case and no Latin
 * decomposition, so each folds to itself — answered without asking the
 * runtime, since a CJK body is mostly distinct characters the memo below
 * would only churn through.
 */
function foldsToItself(unit: number): boolean {
  return (
    (unit >= 0x3040 && unit <= 0x30ff) ||
    (unit >= 0x3400 && unit <= 0x9fff) ||
    (unit >= 0xac00 && unit <= 0xd7af) ||
    (unit >= 0xf900 && unit <= 0xfaff)
  )
}

function foldCodePoint(char: string): FoldedCodePoint {
  const unit = char.charCodeAt(0)
  if (unit < 0x80) return ASCII_LOWER[unit] as FoldedCodePoint
  if (char.length === 1 && foldsToItself(unit)) return { out: char, latin: false }
  const held = foldedCodePoints.get(char)
  if (held !== undefined) return held
  const folded = computeFold(char)
  if (foldedCodePoints.size >= FOLDED_MAX) foldedCodePoints.clear()
  foldedCodePoints.set(char, folded)
  return folded
}

function computeFold(char: string): FoldedCodePoint {
  const lower = char.toLowerCase()
  const decomposed = lower.normalize('NFKD').toLowerCase()
  const first = String.fromCodePoint(decomposed.codePointAt(0) ?? 0)
  if (LATIN.test(first) || ASCII.test(decomposed)) {
    const out = [...decomposed].filter((each) => !MARK.test(each)).join('')
    const last = [...out].at(-1)
    return { out, latin: last !== undefined && LATIN.test(last) }
  }
  return { out: lower, latin: false }
}

const identity = (i: number) => i
const nextUnit = (i: number) => i + 1

/** The folded text, with where each of its code units came from. */
export function foldWithOffsets(text: string): Folded {
  return fold(text, true)
}

export function foldForSearch(text: string): string {
  return fold(text, false).text
}

function recordSource(starts: number[], ends: number[], units: number, from: number, to: number) {
  for (let i = 0; i < units; i++) {
    starts.push(from)
    ends.push(to)
  }
}

function fold(text: string, withOffsets: boolean): Folded {
  // ASCII has no marks and lowercases unit for unit: nearly every path and
  // most English bodies take this branch, at the cost search always paid.
  if (ALL_ASCII.test(text)) return { text: text.toLowerCase(), startOf: identity, endOf: nextUnit }
  let folded = ''
  const starts: number[] = []
  const ends: number[] = []
  let afterLatin = false
  let offset = 0
  for (const char of text) {
    const end = offset + char.length
    if (afterLatin && MARK.test(char)) {
      // The mark belongs to the letter before it: a match ending on that
      // letter ends after its accent, not between the two.
      if (ends.length > 0) ends[ends.length - 1] = end
    } else {
      const { out, latin } = foldCodePoint(char)
      if (withOffsets) recordSource(starts, ends, out.length, offset, end)
      folded += out
      afterLatin = latin
    }
    offset = end
  }
  return { text: folded, startOf: (i) => starts[i] ?? 0, endOf: (i) => ends[i] ?? 0 }
}

/**
 * Where `needle` occurs in `text` once both are folded, as a span of the
 * ORIGINAL `text` — or undefined when it does not, or folds to nothing.
 */
export function findFolded(
  text: string,
  needle: string,
): { readonly index: number; readonly length: number } | undefined {
  const wanted = foldForSearch(needle)
  if (wanted === '') return undefined
  return spanOf(foldWithOffsets(text), wanted)
}

/** `wanted` (already folded) in `folded`, mapped back to an original span. */
export function spanOf(
  folded: Folded,
  wanted: string,
): { readonly index: number; readonly length: number } | undefined {
  const at = wanted === '' ? -1 : folded.text.indexOf(wanted)
  if (at === -1) return undefined
  const index = folded.startOf(at)
  return { index, length: folded.endOf(at + wanted.length - 1) - index }
}
