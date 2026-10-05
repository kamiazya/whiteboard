/**
 * Bounding how much context resolution compares must not move any anchor a
 * writer is allowed to store.
 *
 * The oracle is the resolver as it stood before the bound, kept here
 * verbatim: comparing against the module under test would be the same code
 * twice. Bodies are built from two lines, one of them rare, so occurrences
 * of a quote share long runs of context and differ only where the rare line
 * falls — the arrangement where characters far from the passage decide the
 * winner, and the one a random body almost never reaches.
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

function anchorCase(maxContext: number): fc.Arbitrary<Case> {
  return fc
    .record({
      common: line,
      rare: line,
      picks: fc.array(fc.nat({ max: 7 }), { minLength: 4, maxLength: 70 }),
      site: fc.nat(),
      width: fc.integer({ min: 1, max: 10 }),
      before: contextLength(maxContext),
      after: contextLength(maxContext),
      flipBefore: flip,
      flipAfter: flip,
      stored: fc.nat(),
      storedWidth: fc.nat({ max: 3 }),
    })
    .map((drawn) => {
      const body = drawn.picks.map((pick) => (pick === 0 ? drawn.rare : drawn.common)).join('')
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

const tally = { scored: 0, decidedPastHalf: 0 }

describe('the bounded context window', () => {
  fcTest.prop([anchorCase(TEXT_ANCHOR_CONTEXT_MAX_CHARS)], withDefaults())(
    'resolves a context within the bound exactly as the unbounded resolver',
    ({ body, anchor }) => {
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
    },
  )

  fcTest.prop([anchorCase(3 * TEXT_ANCHOR_CONTEXT_MAX_CHARS)], withDefaults())(
    'judges a longer context on its characters nearest the passage',
    ({ body, anchor }) => {
      expect(resolveTextAnchor(body, anchor)).toEqual(
        referenceResolve(body, nearest(anchor, TEXT_ANCHOR_CONTEXT_MAX_CHARS)),
      )
    },
  )

  afterAllFloor(['resolves a context within the bound exactly as the unbounded resolver'], () => {
    expect(tally.scored).toBeGreaterThan(120)
    expect(tally.decidedPastHalf).toBeGreaterThan(12)
  })
})
