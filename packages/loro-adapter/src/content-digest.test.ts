import { describe, expect, it } from 'vitest'
import { contentDigestOf } from './content-digest.js'

describe('contentDigestOf', () => {
  // A Loro map's JSON comes out in op-arrival order, which differs between
  // replicas that hold the same content. The digest has to see through that
  // or two converged replicas name one state twice.
  it('ignores key order at every level', () => {
    const a = { nodes: { n1: { x: 1, text: 'a' }, n0: { text: 'b', x: 0 } }, body: 'hi' }
    const b = { body: 'hi', nodes: { n0: { x: 0, text: 'b' }, n1: { text: 'a', x: 1 } } }
    expect(contentDigestOf(a)).toBe(contentDigestOf(b))
  })

  it('changes when any value changes', () => {
    const base = { nodes: { n0: { x: 0, text: 'b' } }, body: 'hi' }
    expect(contentDigestOf({ ...base, body: 'hi!' })).not.toBe(contentDigestOf(base))
    expect(contentDigestOf({ ...base, nodes: { n0: { x: 1, text: 'b' } } })).not.toBe(
      contentDigestOf(base),
    )
  })

  // Array ORDER is content — a list of edges in a different order is a
  // different document — so only object keys are sorted, never arrays.
  it('keeps array order as content', () => {
    expect(contentDigestOf({ items: [1, 2] })).not.toBe(contentDigestOf({ items: [2, 1] }))
  })

  it('is sixteen hex characters, so it is a safe path segment and a stable width', () => {
    expect(contentDigestOf({ a: 1 })).toMatch(/^[0-9a-f]{16}$/)
  })
})

/**
 * The key sort is by CODE UNIT, and must stay that way.
 *
 * `Object.keys(...).sort()` compares UTF-16 code units, which gives the
 * same answer in every environment. `localeCompare` does not: it reads the
 * runtime's default locale and ICU data, so identical content would digest
 * differently on two machines — and a digest that depends on where it was
 * computed is not a digest.
 *
 * Guarded because a static analyser asks for the opposite. Sonar's S2871
 * flags `.sort()` with no comparator and suggests `String.localeCompare`;
 * taking that advice here passed all 273 loro-adapter tests, because ASCII
 * keys order the same either way. The breakage appears only with non-ASCII
 * content, in production, silently.
 *
 * `z` (U+007A) and `ä` (U+00E4) are the discriminator: code units put `z`
 * first, every common locale puts `ä` first. `stableStringify` is private,
 * so the ORDER is observed through the digest it produces — which means
 * this pins a literal. That is the point: the value must not drift, and a
 * change to either the sort or the hash has to come past this line.
 */
describe('the digest key order is environment-independent', () => {
  it('orders keys by code unit, which localeCompare would reverse here', () => {
    expect(contentDigestOf({ z: 1, ä: 2 })).toBe('4c44f759684af98a')
  })
})
