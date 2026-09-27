// @vitest-environment node
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { minimalChange, spliceText } from './minimal-change.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

function apply(current: string, next: string): string {
  const { from, to, insert } = minimalChange(current, next)
  return current.slice(0, from) + insert + current.slice(to)
}

describe('minimalChange', () => {
  it('reports an empty change when nothing differs', () => {
    expect(minimalChange('abc', 'abc')).toEqual({ from: 3, to: 3, insert: '' })
  })

  it('confines an append to the tail', () => {
    expect(minimalChange('abc', 'abcdef')).toEqual({ from: 3, to: 3, insert: 'def' })
  })

  it('confines a prepend to the head', () => {
    expect(minimalChange('abc', 'ZZabc')).toEqual({ from: 0, to: 0, insert: 'ZZ' })
  })

  it('confines a middle edit to the middle', () => {
    expect(minimalChange('abcXdef', 'abcYYdef')).toEqual({ from: 3, to: 4, insert: 'YY' })
  })

  it('confines a deletion to the removed range', () => {
    expect(minimalChange('abcdef', 'abef')).toEqual({ from: 2, to: 4, insert: '' })
  })

  it('handles an empty document in either direction', () => {
    expect(apply('', 'hello')).toBe('hello')
    expect(apply('hello', '')).toBe('')
  })

  // The invariant that matters: whatever range this picks, replacing it
  // reproduces `next` exactly. Everything else about the change is an
  // optimization; this is the correctness contract.
  fcTest.prop([fc.string(), fc.string()], withDefaults())(
    'replacing the reported range always yields the target',
    (current, next) => {
      expect(apply(current, next)).toBe(next)
    },
  )

  // A shared prefix/suffix is what the trimming exists to exploit, and
  // fc.string() pairs almost never share one — without this generator the
  // property above passes vacuously on whole-document replacements.
  fcTest.prop([fc.string(), fc.string(), fc.string(), fc.string()], withDefaults())(
    'touches only the differing span when a prefix and suffix are shared',
    (prefix, suffix, a, b) => {
      const change = minimalChange(prefix + a + suffix, prefix + b + suffix)
      expect(apply(prefix + a + suffix, prefix + b + suffix)).toBe(prefix + b + suffix)
      // Never reaches past what the two documents have in common.
      expect(change.from).toBeGreaterThanOrEqual(0)
      expect(change.to).toBeLessThanOrEqual(prefix.length + a.length + suffix.length)
      expect(change.from).toBeLessThanOrEqual(change.to)
    },
  )
})

describe('spliceText', () => {
  // Supplementary-character-dense on purpose: such a character is two
  // UTF-16 units, and the trimmed span lands BETWEEN a pair's halves whenever
  // two of them share one half — '😀'/'😁' share the leading \uD83D, and
  // '😀' (U+1F600) / '𐘀' (U+10600) share the trailing \uDE00 — which Loro
  // refuses outright ("Cannot insert or delete utf-16 in the middle of the
  // codepoint"). Plain fc.string() pairs almost never produce either.
  const text = fc
    .array(fc.constantFrom('a', 'b', '😀', '😁', '\u{10600}', '👍🏽', '\n'), { maxLength: 12 })
    .map((parts) => parts.join(''))

  fcTest.prop([text, text, text, text], withDefaults())(
    'writes the target into a live Loro text, whatever code points the edit touches',
    (prefix, suffix, a, b) => {
      const doc = new LoroDoc()
      const body = doc.getText('body')
      body.insert(0, prefix + a + suffix)
      doc.commit()
      spliceText(body, prefix + b + suffix)
      doc.commit()
      expect(body.toString()).toBe(prefix + b + suffix)
    },
  )

  it('replaces a character with one that shares its trailing unit', () => {
    const doc = new LoroDoc()
    const body = doc.getText('body')
    body.insert(0, 'x😀y')
    expect(spliceText(body, 'x\u{10600}y')).toBe(true)
    expect(body.toString()).toBe('x\u{10600}y')
  })

  it('replaces one emoji with another that shares its leading unit', () => {
    const doc = new LoroDoc()
    const body = doc.getText('body')
    body.insert(0, 'x😀y')
    expect(spliceText(body, 'x😁y')).toBe(true)
    expect(body.toString()).toBe('x😁y')
  })
})
