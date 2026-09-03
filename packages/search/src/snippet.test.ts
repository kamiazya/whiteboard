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
