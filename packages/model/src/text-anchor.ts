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
 *    the anchor last was;
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

import type { TextAnchor } from './annotation.js'

export type ResolvedTextAnchor =
  | { readonly kind: 'placed'; readonly start: number; readonly end: number }
  | { readonly kind: 'orphaned' }

const ORPHANED: ResolvedTextAnchor = { kind: 'orphaned' }

/** Every index where `needle` starts in `haystack`, including overlaps. */
function occurrences(haystack: string, needle: string): number[] {
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

/** How many characters of `context` the body actually has on that side. */
function matchedBefore(body: string, at: number, prefix: string): number {
  const before = body.slice(Math.max(0, at - prefix.length), at)
  let shared = 0
  while (
    shared < before.length &&
    before[before.length - 1 - shared] === prefix[prefix.length - 1 - shared]
  ) {
    shared += 1
  }
  return shared
}

function matchedAfter(body: string, at: number, suffix: string): number {
  const after = body.slice(at, at + suffix.length)
  let shared = 0
  while (shared < after.length && after[shared] === suffix[shared]) shared += 1
  return shared
}

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
  if (body.slice(anchor.start, anchor.end) === exact) {
    return { kind: 'placed', start: anchor.start, end: anchor.end }
  }

  const candidates = occurrences(body, exact)
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
