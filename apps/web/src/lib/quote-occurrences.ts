/**
 * Where each quote occurs in a body, remembered across edits so re-placing an
 * anchor after a keystroke does not search the whole body again.
 *
 * Every surface that draws a passage — the annotation and proposal
 * projections, the rail's orphan badge — answers again on every edit, and an
 * anchor whose stored offsets miss costs a whole-body search each time. An
 * ORPHAN always misses: it never gets a live mark, and its offsets select
 * nothing. A document may hold `DOCUMENT_MAX_OPEN_THREADS` threads and
 * `DOCUMENT_MAX_OPEN_CHANGES` changes, and anyone who may write to it can make
 * every one an orphan, so a keystroke was a thousand searches of the body.
 *
 * What is remembered is a FACT about the body — every start of the quote —
 * not an answer, so the answer is still `resolveTextAnchor`'s:
 * `resolveTextAnchorAmong` places an anchor among the occurrences exactly as
 * the search would. And the fact survives an edit cheaply, because an edit
 * cannot create an occurrence away from where it changed the text: one lying
 * wholly in text the edit left alone was there before. So an edit is answered
 * by moving the remembered occurrences it left alone and searching only a
 * quote's length either side of each changed range.
 */
import {
  type LivePassage,
  type ResolvedTextAnchor,
  resolveTextAnchor,
  resolveTextAnchorAmong,
  type TextAnchor,
  textAnchorOffsetsHold,
  textOccurrences,
} from '@kamiazya/whiteboard-model'

/**
 * One changed range, as CodeMirror's `iterChangedRanges` reports it:
 * `[fromA, toA)` of the old text became `[fromB, toB)` of the new. A list of
 * them is ascending and non-overlapping.
 */
export interface TextEdit {
  readonly fromA: number
  readonly toA: number
  readonly fromB: number
  readonly toB: number
}

/**
 * Every start of each quote in one body, ascending — or `null` for a quote
 * that occurs too often to be worth remembering, which is resolved as
 * `resolveTextAnchor` always resolved it.
 */
export type KnownQuotes = ReadonlyMap<string, readonly number[] | null>

export const NO_KNOWN_QUOTES: KnownQuotes = new Map()

/**
 * The most occurrences of one quote remembered. Past it, keeping the list
 * current costs an edit more than the search it saves, and placing among
 * them scores up to `SCORED_OCCURRENCES_MAX` candidates however they were
 * found.
 */
const REMEMBERED_OCCURRENCES_MAX = 64

/** Where an occurrence starting at `start` sits after `edits`, or undefined when an edit touched it. */
function shifted(start: number, length: number, edits: readonly TextEdit[]): number | undefined {
  let delta = 0
  for (const edit of edits) {
    if (start + length <= edit.fromA) break
    if (start < edit.toA) return undefined
    delta += edit.toB - edit.fromB - (edit.toA - edit.fromA)
  }
  return start + delta
}

/**
 * Every occurrence of `quote` in `body` that overlaps one of `edits`' new
 * ranges — the only places an edit can have made one. A deletion's range is
 * empty, and an occurrence spanning the join it left counts as overlapping it.
 */
function occurrencesNear(body: string, quote: string, edits: readonly TextEdit[]): number[] {
  const windows: { from: number; to: number }[] = []
  let searched = 0
  for (const edit of edits) {
    const from = Math.max(0, edit.fromB - quote.length + 1)
    const to = Math.min(body.length, edit.toB + quote.length - 1)
    const last = windows.at(-1)
    if (last !== undefined && from <= last.to) {
      searched += Math.max(0, to - last.to)
      last.to = Math.max(last.to, to)
    } else if (to > from) {
      searched += to - from
      windows.push({ from, to })
    }
  }
  // Edits scattered wider than the body: one search of it is the cheaper.
  if (searched >= body.length) return textOccurrences(body, quote)
  return windows.flatMap(({ from, to }) =>
    textOccurrences(body.slice(from, to), quote).map((at) => at + from),
  )
}

function remembered(occurrences: Iterable<number>): readonly number[] | null {
  const sorted = [...new Set(occurrences)].sort((a, b) => a - b)
  return sorted.length <= REMEMBERED_OCCURRENCES_MAX ? sorted : null
}

/**
 * `known`, true of the body before `edits`, made true of `body` after them.
 * Only quotes in `keep` are carried, when it is given.
 */
export function advanceKnownQuotes(
  known: KnownQuotes,
  body: string,
  edits: readonly TextEdit[],
  keep?: ReadonlySet<string>,
): KnownQuotes {
  if (edits.length === 0 && keep === undefined) return known
  const next = new Map<string, readonly number[] | null>()
  for (const [quote, at] of known) {
    if (keep !== undefined && !keep.has(quote)) continue
    if (at === null || edits.length === 0) {
      next.set(quote, at)
      continue
    }
    const moved: number[] = []
    for (const start of at) {
      const now = shifted(start, quote.length, edits)
      if (now !== undefined) moved.push(now)
    }
    next.set(quote, remembered([...moved, ...occurrencesNear(body, quote, edits)]))
  }
  return next
}

/** The one edit that turns `before` into `after`: what lies between their common prefix and suffix. */
export function editBetween(before: string, after: string): readonly TextEdit[] {
  if (before === after) return []
  const shorter = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < shorter && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1
  let suffix = 0
  while (
    suffix < shorter - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1
  }
  return [{ fromA: prefix, toA: before.length - suffix, fromB: prefix, toB: after.length - suffix }]
}

/**
 * `resolveTextAnchor`'s answer for `anchor` in `body`, searching only for a
 * quote neither `known` nor `learnt` holds. What a search finds is written to
 * `learnt` — a map the caller owns for this body — so the next edit can
 * advance it.
 */
export function resolveRemembering(
  body: string,
  anchor: TextAnchor,
  live: LivePassage | undefined,
  known: KnownQuotes,
  learnt: Map<string, readonly number[] | null>,
): ResolvedTextAnchor {
  // A live mark answers outright, without reading the body.
  if (live !== undefined) return resolveTextAnchor(body, anchor, live)
  const { exact } = anchor.quote
  let at = learnt.has(exact) ? learnt.get(exact) : known.get(exact)
  if (at === undefined) {
    // Offsets that still hold answer without a search; nothing to learn.
    if (textAnchorOffsetsHold(body, anchor)) return resolveTextAnchor(body, anchor)
    at = remembered(textOccurrences(body, exact))
  }
  learnt.set(exact, at)
  return at === null ? resolveTextAnchor(body, anchor) : resolveTextAnchorAmong(body, anchor, at)
}

/** The edits a CodeMirror change set makes, in the shape `advanceKnownQuotes` takes. */
export function textEditsOf(changes: {
  iterChangedRanges(f: (fromA: number, toA: number, fromB: number, toB: number) => void): void
}): readonly TextEdit[] {
  const edits: TextEdit[] = []
  changes.iterChangedRanges((fromA, toA, fromB, toB) => edits.push({ fromA, toA, fromB, toB }))
  return edits
}

/**
 * What a surface handed whole bodies rather than a change set keeps between
 * them: the body, what was known of it, and what asking it has learnt since.
 * `learnt` is filled by `resolveRemembering` as the surface asks.
 */
export interface QuoteMemory {
  readonly body: string
  readonly known: KnownQuotes
  readonly learnt: Map<string, readonly number[] | null>
}

/** `previous`, carried forward to `body` through the one edit between them. */
export function quoteMemoryFor(previous: QuoteMemory | null, body: string): QuoteMemory {
  if (previous?.body === body) return previous
  const known =
    previous === null
      ? NO_KNOWN_QUOTES
      : advanceKnownQuotes(
          new Map([...previous.known, ...previous.learnt]),
          body,
          editBetween(previous.body, body),
        )
  return { body, known, learnt: new Map() }
}
