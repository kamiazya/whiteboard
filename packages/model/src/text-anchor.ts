/**
 * Finding a text anchor's passage in a body that has since been edited.
 *
 * A stored anchor carries both a POSITION (`start`/`end`) and a QUOTE
 * (`exact`, with optional `prefix`/`suffix`). The position is what makes the
 * common case free — nothing moved, so the offsets still hold — and the quote
 * is what survives everything else, which is why `annotation.ts` marks
 * `exact` required and the neighbours optional. This module is the reader
 * that uses both.
 *
 * Offsets alone cannot work. A body is a CRDT that anyone can edit from
 * anywhere: a character typed in the first paragraph moves every anchor below
 * it, and a thread whose offsets are not re-derived would silently point at
 * different words. Pointing at the wrong words is worse than saying "this one
 * has lost its place" — a reader can act on the second and cannot even detect
 * the first.
 *
 * The resolution order follows W3C Web Annotation's TextQuoteSelector, which
 * is what the schema was modelled on:
 *
 * 1. the stored offsets, if the text there is still the quote;
 * 2. the only occurrence of the quote elsewhere;
 * 3. among several occurrences, the one whose surroundings match `prefix` and
 *    `suffix` best, and — where that still ties — the one nearest to where
 *    the anchor last was. Only the `SCORED_OCCURRENCES_MAX` occurrences
 *    nearest that position are scored, so a quote that occurs everywhere
 *    costs a bounded amount to place;
 * 4. nothing: the passage is gone, and the thread is orphaned (ADR-0026
 *    decision 4 — deleting the subject must not delete the conversation).
 *
 * It lives in the shared layer rather than beside the editor that first
 * needed it because TWO layers now ask this question of the same body: the
 * annotation layer's in-place projection, and a proposed replacement passage
 * deciding where it applies (ADR-0029 decision 6). A second implementation
 * would be a second answer, and the two would disagree exactly where it
 * matters — a passage one of them calls lost while the other rewrites it.
 */

import { TEXT_ANCHOR_CONTEXT_MAX_CHARS, type TextAnchor } from './annotation.js'

export type ResolvedTextAnchor =
  | { readonly kind: 'placed'; readonly start: number; readonly end: number }
  | { readonly kind: 'orphaned' }

const ORPHANED: ResolvedTextAnchor = { kind: 'orphaned' }

/**
 * The longest quote searched with `indexOf`. Past it the search is linear.
 *
 * `indexOf` re-verifies the whole needle at every candidate, so on a periodic
 * body its cost is `body.length x needle.length` — even for a single call
 * that finds nothing. Measured on a 256 Ki body of one repeated character:
 * every occurrence of a 64 Ki run took 9.7 s, and one search for a 64 Ki
 * needle with one different character in its middle 6.3 s. Below this length
 * the worst case stays under ~60 ms while `indexOf`'s native scan keeps the
 * ordinary case near free (0.1 ms against the linear search's 21 ms for a
 * 300-character quote in 200 Ki of prose), and quotes this short are most of
 * what anyone writes.
 */
const NATIVE_SEARCH_MAX_CHARS = 256

/**
 * Every index where `needle` starts in `haystack`, including overlaps — at
 * most `haystack.length x NATIVE_SEARCH_MAX_CHARS` steps whatever the text
 * repeats. Exported because the canvas re-finds a passage in RENDERED text
 * and must use this search rather than grow a second one.
 */
export function textOccurrences(haystack: string, needle: string): number[] {
  return needle.length <= NATIVE_SEARCH_MAX_CHARS
    ? nativeOccurrences(haystack, needle)
    : linearOccurrences(haystack, needle)
}

function nativeOccurrences(haystack: string, needle: string): number[] {
  const found: number[] = []
  // `indexOf` from the previous hit PLUS ONE, not plus the needle's length:
  // overlapping occurrences are real candidates ("aa" in "aaa" starts twice),
  // and skipping them would make the count wrong in exactly the case where
  // disambiguation matters.
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at)
  }
  return found
}

/**
 * Knuth–Morris–Pratt: every occurrence, overlaps included, in
 * `haystack.length + needle.length` steps whatever the text repeats.
 */
function linearOccurrences(haystack: string, needle: string): number[] {
  // `border[i]` is the length of the longest proper prefix of
  // `needle[0..i]` that is also its suffix: where matching resumes after a
  // mismatch, and after a full match, which is what keeps overlaps.
  const border = new Int32Array(needle.length)
  for (let i = 1, k = 0; i < needle.length; i += 1) {
    while (k > 0 && needle[i] !== needle[k]) k = border[k - 1] as number
    if (needle[i] === needle[k]) k += 1
    border[i] = k
  }
  const found: number[] = []
  for (let i = 0, k = 0; i < haystack.length; i += 1) {
    while (k > 0 && haystack[i] !== needle[k]) k = border[k - 1] as number
    if (haystack[i] === needle[k]) k += 1
    if (k === needle.length) {
      found.push(i - k + 1)
      k = border[k - 1] as number
    }
  }
  return found
}

/**
 * How many characters of a quote's `context` a text still has beside the
 * passage. `read(k)` is the text's `k`-th character outward from the passage
 * — `read(0)` the one touching it — and `undefined` past the text's edge;
 * `side` says which end of `context` touches the passage: a prefix's last
 * character, a suffix's first.
 *
 * Only the nearest `TEXT_ANCHOR_CONTEXT_MAX_CHARS` count, so one occurrence
 * costs a bounded comparison however long the stored context is. An anchor
 * written before tools refused a longer context still resolves, judged on its
 * nearest characters.
 *
 * The text is read through a function because not every reader has the
 * body: the canvas re-finds a passage in RENDERED text, whose whitespace it
 * compares loosely, and it must apply this rule rather than a copy of it.
 */
export function sharedContext(
  context: string,
  side: 'before' | 'after',
  read: (k: number) => string | undefined,
): number {
  const reach = Math.min(context.length, TEXT_ANCHOR_CONTEXT_MAX_CHARS)
  let shared = 0
  while (shared < reach) {
    const expected = side === 'before' ? context[context.length - 1 - shared] : context[shared]
    if (read(shared) !== expected) break
    shared += 1
  }
  return shared
}

/**
 * The most occurrences of one quote that resolution scores: the ones nearest
 * where the anchor last was.
 *
 * Without it, placing an anchor whose offsets missed collected and scored
 * EVERY occurrence, so a one-character quote in a 256 Ki body was 128 Ki
 * occurrences, each read for up to 66 characters of context — and a writer
 * re-places every open passage of a proposal it continues, up to
 * `DOCUMENT_MAX_OPEN_CHANGES` of them, under the workspace's write lock.
 * Measured through `wb_body_edit` on a periodic 256 Ki body with 999 open
 * changes: 127 s for one call, and 1.7 s with the bound.
 *
 * A quote with at most this many occurrences is placed exactly as without
 * the bound. Past it, the occurrences further away lose only to a nearer one,
 * which is the evidence that survives best anyway: a quote that common says
 * little on its own, and the far ones are reached only by an edit moving the
 * passage by thousands of its own occurrences. High enough that the existing
 * bodies of every property in `text-anchor-context.property.test.ts` stay
 * under it.
 */
const SCORED_OCCURRENCES_MAX = 1024

/**
 * Start positions searched per step outward from the anchor. Each step
 * collects every occurrence inside it, so this bounds how far past the
 * scored ones a search can collect; a quote longer than this steps by its
 * own length, which keeps the re-read overlap at each step's edge from
 * costing more than the step.
 */
const OUTWARD_STEP_CHARS = 4096

/**
 * The occurrences of `exact` nearest `around`, nearest first: all of them
 * when there are at most `max`, otherwise the `max` nearest. Of two equally
 * near, the lower comes first and is the one kept at the cut — the order
 * resolution's own tiebreak prefers, so scoring in this order picks what
 * scoring in body order would.
 *
 * Searched outward from `around` a step at a time on each side, stopping a
 * side once it holds `max`: any occurrence past that is further than `max`
 * others on its own side, so it cannot be among the nearest `max`. A dense
 * quote therefore costs a few steps, and a sparse one the single pass over
 * the body it always cost.
 */
function nearestOccurrences(body: string, exact: string, around: number, max: number): number[] {
  const lastStart = body.length - exact.length
  if (lastStart < 0) return []
  const centre = Math.min(around, lastStart + 1)
  const step = Math.max(OUTWARD_STEP_CHARS, exact.length)
  // Starts in [from, to): the slice runs on by the quote's length less one so
  // an occurrence starting just before `to` is whole in it, and no further,
  // so the next step never finds it a second time.
  const startsWithin = (from: number, to: number): number[] =>
    textOccurrences(body.slice(from, to + exact.length - 1), exact).map((at) => at + from)

  const before: number[] = []
  for (let to = centre; to > 0 && before.length < max; to -= step) {
    const found = startsWithin(Math.max(0, to - step), to)
    for (let i = found.length - 1; i >= 0; i -= 1) before.push(found[i] as number)
  }
  const after: number[] = []
  for (let from = centre; from <= lastStart && after.length < max; from += step) {
    for (const at of startsWithin(from, Math.min(lastStart + 1, from + step))) after.push(at)
  }
  return nearestFirst(before, after, around, max)
}

/**
 * The `max` nearest of two runs that each move away from `around` — `before`
 * downward, `after` upward — merged nearest first, the lower of two equally
 * near taken first.
 */
function nearestFirst(before: number[], after: number[], around: number, max: number): number[] {
  const nearest: number[] = []
  let b = 0
  let a = 0
  while (nearest.length < max && (b < before.length || a < after.length)) {
    const left = before[b]
    const right = after[a]
    if (right === undefined || (left !== undefined && around - left <= right - around)) {
      nearest.push(left as number)
      b += 1
    } else {
      nearest.push(right)
      a += 1
    }
  }
  return nearest
}

const matchedBefore = (body: string, at: number, prefix: string): number =>
  sharedContext(prefix, 'before', (k) => body[at - 1 - k])

const matchedAfter = (body: string, at: number, suffix: string): number =>
  sharedContext(suffix, 'after', (k) => body[at + k])

/**
 * Where the CRDT still holds this passage, when it does.
 *
 * A Loro rich-text mark on the body belongs to the CHARACTERS it covers, so
 * it followed every edit that moved them — including a concurrent one merged
 * from another peer, which is precisely what offsets and a quote cannot
 * reproduce. It is the live answer; the quote below is the durable one.
 */
export interface LivePassage {
  readonly start: number
  readonly end: number
}

export function resolveTextAnchor(
  body: string,
  anchor: TextAnchor,
  live?: LivePassage,
): ResolvedTextAnchor {
  // The mark wins outright rather than being scored against the quote. It is
  // not a better guess at where the passage is — it IS where the passage is,
  // maintained by the same structure that moved the text. Reading the quote
  // afterwards could only disagree with the truth.
  //
  // Absent means "this document has no mark for that thread", which happens
  // for every document that arrived through a markdown file (marks do not
  // travel through the text) and for every thread written before marks
  // existed. That is a reason to ask the quote, never a reason to orphan.
  if (live !== undefined) return { kind: 'placed', start: live.start, end: live.end }

  const { exact, prefix = '', suffix = '' } = anchor.quote
  // The stored offsets first. This is a COST shortcut, not a rule about which
  // answer is right: on consistent data the search below reproduces it (the
  // stored site is at distance 0 from itself, so it wins the tiebreak), and
  // removing this branch leaves every test in this module green. That is the
  // branch being a shortcut, not a hole in the tests.
  //
  // It is kept because the cost is not small and grows with the document.
  // Measured, unique quotes and 2000 resolutions, this branch versus search
  // only: 8KB body 0.5ms vs 12.3ms (24x), 48KB 0.4ms vs 61.0ms (170x), 200KB
  // 0.1ms vs 228.1ms (2016x). The search scans the whole body once per
  // anchor; this compares `exact.length` characters and stops.
  //
  // The length check is not redundant with the comparison: `slice` CLAMPS, so
  // on a body shorter than the stored `end` it returns the tail rather than
  // nothing, and a stored range whose width disagrees with its own quote then
  // MATCHES and is answered verbatim — an `end` the body does not have.
  // Measured: `'hello world'.slice(6, 20)` is `'world'`. Reached in practice
  // by an anchor stored with `end - start !== exact.length`, which is ordinary
  // once a quote and its offsets are written by different paths; observed as
  // `Index out of bound. The given pos is 20, but the length is 19` thrown
  // from inside Loro by `markThreadPassages`, and swallowed by a catch.
  if (anchor.end <= body.length && body.slice(anchor.start, anchor.end) === exact) {
    return { kind: 'placed', start: anchor.start, end: anchor.end }
  }

  const candidates = nearestOccurrences(body, exact, anchor.start, SCORED_OCCURRENCES_MAX)
  if (candidates.length === 0) return ORPHANED
  const at = candidates[0] as number
  if (candidates.length === 1) return { kind: 'placed', start: at, end: at + exact.length }

  // Score by how much of the remembered surroundings each candidate still
  // has, and break the remaining ties by distance from where the anchor last
  // was. Distance is the tiebreak rather than the score because it is the
  // weaker evidence: an edit above the passage moves every offset, so a
  // candidate can be far from `start` and still be the right one.
  let best = at
  let bestScore = -1
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const score =
      matchedBefore(body, candidate, prefix) + matchedAfter(body, candidate + exact.length, suffix)
    const distance = Math.abs(candidate - anchor.start)
    if (score > bestScore || (score === bestScore && distance < bestDistance)) {
      best = candidate
      bestScore = score
      bestDistance = distance
    }
  }
  return { kind: 'placed', start: best, end: best + exact.length }
}

/**
 * The anchor as a writer stores it: re-stated at the offsets its quote
 * resolves to in `text`, or `undefined` when the passage is not there.
 *
 * The quote is what finds a passage and the offsets are only the shortcut
 * `resolveTextAnchor` tries first, so offsets a caller miscounted are a hint
 * the quote overrides. Storing them as given would leave an anchor that
 * contradicts itself, and every later reader would miss the shortcut and
 * search the whole text again; refusing would reject a call over a number no
 * reader relies on. Offsets that already select the quote are kept, which is
 * what keeps the chosen occurrence of a quote that appears more than once.
 */
export function placeTextAnchor<A extends TextAnchor>(text: string, anchor: A): A | undefined {
  const placed = resolveTextAnchor(text, anchor)
  if (placed.kind !== 'placed') return undefined
  if (placed.start === anchor.start && placed.end === anchor.end) return anchor
  return { ...anchor, start: placed.start, end: placed.end }
}
