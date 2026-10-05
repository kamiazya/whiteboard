/**
 * Making resolution cheap must not move any anchor a writer is allowed to
 * store: neither the bounded context window nor the linear search for a long
 * quote.
 *
 * The oracle is the resolver as it stood before either, kept here verbatim
 * — unbounded context, `indexOf` for every quote: comparing against the
 * module under test would be the same code twice. Bodies are built from two
 * lines, one of them rare, so occurrences of a quote share long runs of
 * context and differ only where the rare line falls — the arrangement where
 * characters far from the passage decide the winner, and the one a random
 * body almost never reaches.
 */
import { describe, expect } from 'vitest'
import { TEXT_ANCHOR_CONTEXT_MAX_CHARS, type TextAnchor } from './annotation.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import { afterAllFloor } from './test-utils/reachability-floor.js'
import { resolveTextAnchor } from './text-anchor.js'

type Resolved = ReturnType<typeof resolveTextAnchor>

function referenceOccurrences(haystack: string, needle: string): number[] {
  const found: number[] = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    found.push(at)
  }
  return found
}

function referenceBefore(body: string, at: number, prefix: string): number {
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

function referenceAfter(body: string, at: number, suffix: string): number {
  const after = body.slice(at, at + suffix.length)
  let shared = 0
  while (shared < after.length && after[shared] === suffix[shared]) shared += 1
  return shared
}

/** The unbounded resolver, for a body with no live mark. */
function referenceResolve(body: string, anchor: TextAnchor): Resolved {
  const { exact, prefix = '', suffix = '' } = anchor.quote
  if (anchor.end <= body.length && body.slice(anchor.start, anchor.end) === exact) {
    return { kind: 'placed', start: anchor.start, end: anchor.end }
  }
  const candidates = referenceOccurrences(body, exact)
  if (candidates.length === 0) return { kind: 'orphaned' }
  const at = candidates[0] as number
  if (candidates.length === 1) return { kind: 'placed', start: at, end: at + exact.length }
  let best = at
  let bestScore = -1
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const score =
      referenceBefore(body, candidate, prefix) +
      referenceAfter(body, candidate + exact.length, suffix)
    const distance = Math.abs(candidate - anchor.start)
    if (score > bestScore || (score === bestScore && distance < bestDistance)) {
      best = candidate
      bestScore = score
      bestDistance = distance
    }
  }
  return { kind: 'placed', start: best, end: best + exact.length }
}

/** The anchor with each context cut to its `limit` characters nearest the passage. */
function nearest(anchor: TextAnchor, limit: number): TextAnchor {
  const { prefix, suffix, exact } = anchor.quote
  return {
    ...anchor,
    quote: {
      exact,
      ...(prefix === undefined ? {} : { prefix: limit === 0 ? '' : prefix.slice(-limit) }),
      ...(suffix === undefined ? {} : { suffix: suffix.slice(0, limit) }),
    },
  }
}

const line = fc.stringMatching(/^[ab ]{1,7}$/).map((text) => `${text}\n`)

/** One character of `text` changed, so a context can stop matching partway out. */
function perturbed(text: string, at: number | 'far' | undefined, far: number): string {
  if (at === undefined) return text
  const index = at === 'far' ? far : at % text.length
  return `${text.slice(0, index)}${text[index] === 'a' ? 'b' : 'a'}${text.slice(index + 1)}`
}

/** Mostly the whole allowance, since the far end of a context is what the bound cuts. */
const contextLength = (max: number) =>
  fc.oneof({ weight: 2, arbitrary: fc.constant(max) }, { weight: 1, arbitrary: fc.nat({ max }) })

/**
 * Where to change one character of a context, if anywhere. `far` is the
 * character furthest from the passage: with every nearer one still matching,
 * it is the one that decides between a candidate inside the bound and one
 * just outside it.
 */
const flip = fc.oneof(
  { weight: 2, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.constant('far' as const) },
  { weight: 1, arbitrary: fc.nat() },
)

interface Case {
  readonly body: string
  readonly anchor: TextAnchor
}

/**
 * A body of many short lines, one in eight the rare one: occurrences of a
 * short quote are plentiful and their contexts diverge where a rare line
 * falls.
 */
const shortQuoteBody = fc
  .record({
    common: line,
    rare: line,
    picks: fc.array(fc.nat({ max: 7 }), { minLength: 4, maxLength: 70 }),
  })
  .map(({ common, rare, picks }) => picks.map((pick) => (pick === 0 ? rare : common)).join(''))

/**
 * One line repeated hundreds of times with at most two rare lines in it, so a
 * quote far longer than a line still occurs many times, overlapping: the case
 * a search that resumes past a match instead of inside it gets wrong. Drawn
 * from a few scalars rather than a line per element, because the oracle is
 * quadratic on exactly these bodies and shrinking an array of hundreds of
 * picks against it runs for minutes.
 */
const longQuoteBody = fc
  .record({
    common: line,
    rare: line,
    count: fc.integer({ min: 300, max: 600 }),
    rareAt: fc.array(fc.nat(), { maxLength: 2 }),
  })
  .map(({ common, rare, count, rareAt }) => {
    const lines = Array.from({ length: count }, () => common)
    for (const at of rareAt) lines[at % count] = rare
    return lines.join('')
  })

interface Shape {
  readonly body: fc.Arbitrary<string>
  readonly maxContext: number
  /** The shortest and longest quote drawn. */
  readonly minWidth: number
  readonly maxWidth: number
}

function anchorCase({ body: bodies, maxContext, minWidth, maxWidth }: Shape): fc.Arbitrary<Case> {
  return fc
    .record({
      body: bodies,
      site: fc.nat(),
      width: fc.integer({ min: minWidth, max: maxWidth }),
      before: contextLength(maxContext),
      after: contextLength(maxContext),
      flipBefore: flip,
      flipAfter: flip,
      stored: fc.nat(),
      storedWidth: fc.nat({ max: 3 }),
    })
    .map((drawn) => {
      const { body } = drawn
      const at = drawn.site % body.length
      const exact = body.slice(at, Math.min(body.length, at + drawn.width))
      const prefix = body.slice(Math.max(0, at - drawn.before), at)
      const suffix = body.slice(at + exact.length, at + exact.length + drawn.after)
      const start = drawn.stored % (body.length + 1)
      return {
        body,
        anchor: {
          kind: 'text' as const,
          quote: {
            exact,
            ...(prefix === '' ? {} : { prefix: perturbed(prefix, drawn.flipBefore, 0) }),
            ...(suffix === ''
              ? {}
              : { suffix: perturbed(suffix, drawn.flipAfter, suffix.length - 1) }),
          },
          start,
          end: start + drawn.storedWidth,
        },
      }
    })
}

const SHORT_QUOTES = { body: shortQuoteBody, minWidth: 1, maxWidth: 10 }

/** Lengths straddle every plausible switch between a native and a linear search. */
const LONG_QUOTES = {
  body: longQuoteBody,
  maxContext: TEXT_ANCHOR_CONTEXT_MAX_CHARS,
  minWidth: 200,
  maxWidth: 900,
}

const tally = { scored: 0, decidedPastHalf: 0, longOverlapping: 0 }

describe('the bounded context window', () => {
  fcTest.prop(
    [anchorCase({ maxContext: TEXT_ANCHOR_CONTEXT_MAX_CHARS, ...SHORT_QUOTES })],
    withDefaults(),
  )('resolves a context within the bound exactly as the unbounded resolver', ({ body, anchor }) => {
    const expected = referenceResolve(body, anchor)
    expect(resolveTextAnchor(body, anchor)).toEqual(expected)

    // Reachability: the cases where context past half the bound changed the
    // winner are the ones that would catch a window set too small.
    if (referenceOccurrences(body, anchor.quote.exact).length > 1) tally.scored += 1
    const half = Math.floor(TEXT_ANCHOR_CONTEXT_MAX_CHARS / 2)
    if (
      JSON.stringify(referenceResolve(body, nearest(anchor, half))) !== JSON.stringify(expected)
    ) {
      tally.decidedPastHalf += 1
    }
  })

  fcTest.prop(
    [anchorCase({ maxContext: 3 * TEXT_ANCHOR_CONTEXT_MAX_CHARS, ...SHORT_QUOTES })],
    withDefaults(),
  )('judges a longer context on its characters nearest the passage', ({ body, anchor }) => {
    expect(resolveTextAnchor(body, anchor)).toEqual(
      referenceResolve(body, nearest(anchor, TEXT_ANCHOR_CONTEXT_MAX_CHARS)),
    )
  })

  afterAllFloor(['resolves a context within the bound exactly as the unbounded resolver'], () => {
    expect(tally.scored).toBeGreaterThan(120)
    expect(tally.decidedPastHalf).toBeGreaterThan(12)
  })
})

describe('finding every occurrence of a long quote', () => {
  fcTest.prop([anchorCase(LONG_QUOTES)], withDefaults({ numRuns: 100 }))(
    'places a long quote exactly as the unbounded resolver, overlapping occurrences included',
    ({ body, anchor }) => {
      expect(resolveTextAnchor(body, anchor)).toEqual(referenceResolve(body, anchor))

      const { exact } = anchor.quote
      const found = referenceOccurrences(body, exact)
      if (
        exact.length > 512 &&
        found.some((at, i) => i > 0 && at - (found[i - 1] as number) < exact.length)
      ) {
        tally.longOverlapping += 1
      }
    },
  )

  afterAllFloor(
    ['places a long quote exactly as the unbounded resolver, overlapping occurrences included'],
    () => {
      expect(tally.longOverlapping).toBeGreaterThan(5)
    },
  )
})
