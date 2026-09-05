/**
 * `snippetAround` cuts by UTF-16 CODE UNIT, and every character outside the
 * BMP — emoji, and the rare CJK ideographs a Japanese document reaches for —
 * is two of them. A radius landing between the two halves emitted a lone
 * surrogate: a broken glyph at the edge of every search result and backlink
 * context showing that document.
 *
 * The property below is written so the cut ALWAYS lands inside an astral run,
 * with `k` deciding whether it lands between a character's halves or on the
 * boundary between two. Leaving that to independently-arbitrary inputs is how
 * this kind of property passes without ever reaching the case it names, so the
 * tally below counts the runs that actually entered it.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { CONTEXT_RADIUS, snippetAround } from './snippet.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

/** How many unpaired surrogates a string carries. Zero is the contract. */
function unpairedSurrogates(value: string): number {
  let count = 0
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i += 1
      else count += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) count += 1
  }
  return count
}

const NEEDLE = 'NEEDLE'
/** Comfortably longer than the radius, so the cut cannot fall outside it. */
const RUN = CONTEXT_RADIUS + 20

/**
 * Runs whose start boundary landed STRICTLY INSIDE a two-unit character —
 * the arrangement the fix exists for. Asserted against a floor because a
 * generator that never reaches it makes the surrogate assertion below
 * vacuously true, which reads exactly like a thorough test.
 */
let enteredDefectZone = 0

afterAll(() => {
  expect(
    enteredDefectZone,
    'the generator never put a cut inside a character — the surrogate property proved nothing',
  ).toBeGreaterThan(20)
})

describe('snippetAround', () => {
  fcTest.prop([fc.integer({ min: 0, max: 7 }), fc.constantFrom('🎨', '𠮷', '😀')], withDefaults())(
    'never cuts a character in half',
    (k, astral) => {
      const body = `${astral.repeat(RUN)}${'y'.repeat(k)}${NEEDLE}${astral.repeat(RUN)}`
      const index = body.indexOf(NEEDLE)
      const start = index - CONTEXT_RADIUS
      // Inside a character exactly when the unit at the boundary is the second
      // half of one — which is what `k`'s parity moves.
      const unit = body.charCodeAt(start)
      if (unit >= 0xdc00 && unit <= 0xdfff) enteredDefectZone += 1

      expect(unpairedSurrogates(snippetAround(body, index, NEEDLE.length))).toBe(0)
    },
  )

  // The measured reproduction, kept as a named companion to the property: the
  // property says "for any of these", this says "this one, concretely".
  it('does not leave a broken glyph where the radius falls between two halves', () => {
    const body = `${'🎨'.repeat(40)}y${NEEDLE}${'🎨'.repeat(40)}`
    const out = snippetAround(body, body.indexOf(NEEDLE), NEEDLE.length)
    expect(unpairedSurrogates(out)).toBe(0)
    expect(out).toContain(NEEDLE)
  })

  it('adds no ellipsis for a string that fits inside the radius', () => {
    expect(snippetAround('a short body', 2, 5)).toBe('a short body')
  })

  it('marks only the end when the cut starts at the beginning', () => {
    const body = `start ${'x'.repeat(400)}`
    expect(snippetAround(body, 0, 5)).toMatch(/^start x+…$/)
  })

  it('marks only the start when the cut reaches the end', () => {
    const body = `${'x'.repeat(400)} end`
    const out = snippetAround(body, body.length - 3, 3)
    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('…')).toBe(false)
  })

  it('collapses whitespace runs to a single space', () => {
    expect(snippetAround('a  \n\t b', 0, 1)).toBe('a b')
  })
})

/**
 * The cut falls between GRAPHEMES, not code points.
 *
 * Code-point snapping (above) stops a lone surrogate; it does not stop a
 * flag, a ZWJ family or a combining mark being cut in half. The flag case is
 * the one with teeth: a cut inside a run of regional indicators leaves an
 * odd half at the edge, and the segmenter on the OUTPUT then pairs every
 * following flag one half off — the excerpt shows flags the document does
 * not hold. That is an excerpt that lies, not one that looks rough.
 */
describe('snippetAround cuts between characters a reader sees as one', () => {
  const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const split = (value: string): string[] => [...GRAPHEMES.segment(value)].map((g) => g.segment)
  const boundaries = (value: string): Set<number> => {
    const at = new Set<number>()
    for (const g of GRAPHEMES.segment(value)) at.add(g.index)
    at.add(value.length)
    return at
  }

  const CLASSES = ['👨‍👩‍👧‍👦', '🇯🇵', '👍🏽', '1️⃣', 'e\u0301', 'ｶﾞ'] as const
  /** Longer than the radius in code units for every class, so the cut stays in the run. */
  const RUN = CONTEXT_RADIUS

  /**
   * Runs whose start boundary landed STRICTLY INSIDE a cluster. Counted, and
   * floored, for the same reason as `enteredDefectZone`: the assertion below
   * is vacuous over a sweep that only ever cuts on a boundary.
   */
  let cutInsideACluster = 0

  afterAll(() => {
    expect(
      cutInsideACluster,
      'the sweep never cut inside a cluster — the grapheme property proved nothing',
    ).toBeGreaterThan(20)
  })

  fcTest.prop([fc.integer({ min: 0, max: 11 }), fc.constantFrom(...CLASSES)], withDefaults())(
    'every grapheme of the excerpt is a grapheme of the source',
    (k, cluster) => {
      // `k` filler units BETWEEN the run and the needle walk the cut through
      // every interior offset of the cluster; the run's own start is fixed.
      const body = `${cluster.repeat(RUN)}${'y'.repeat(k)}${NEEDLE}${cluster.repeat(RUN)}`
      const index = body.indexOf(NEEDLE)
      if (!boundaries(body).has(index - CONTEXT_RADIUS)) cutInsideACluster += 1

      const out = snippetAround(body, index, NEEDLE.length)
      const source = new Set(split(body))
      const foreign = split(out).filter((g) => g !== '…' && g !== ' ' && !source.has(g))
      expect(foreign).toEqual([])
    },
  )

  it('honours a Prepend: the character after one is never the first thing shown', () => {
    // Every code point in the first two planes, each put right before the
    // start cut with an ASCII letter ON the cut — the one shape the cheap
    // boundary test would wave through. The runtime's segmenter is the
    // oracle, so a Unicode update that moves the Prepend set fails here
    // rather than in someone's Arabic search results.
    const tail = `${'b'.repeat(CONTEXT_RADIUS - 1)}${NEEDLE}`
    const misses: string[] = []
    let prepends = 0
    for (let cp = 0; cp < 0x20000; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const head = String.fromCodePoint(cp)
      const body = `${head}a${tail}`
      const joined = split(`${head}a`).length === 1
      if (joined) prepends += 1
      const out = snippetAround(body, body.indexOf(NEEDLE), NEEDLE.length)
      const expected = joined ? `…${tail}` : `…a${tail}`
      if (out !== expected) misses.push(`U+${cp.toString(16)}: ${JSON.stringify(out)}`)
    }
    expect(misses).toEqual([])
    expect(prepends, 'no Prepend found — the sweep tested nothing').toBeGreaterThan(20)
  })

  it('never shows a flag the document does not hold', () => {
    // k=2 puts the cut between the two regional indicators of one flag.
    const body = `${'🇯🇵'.repeat(RUN)}yy${NEEDLE}${'🇯🇵'.repeat(RUN)}`
    const out = snippetAround(body, body.indexOf(NEEDLE), NEEDLE.length)
    const first = split(out).find((g) => g !== '…')
    expect(first).toBe('🇯🇵')
  })
})
