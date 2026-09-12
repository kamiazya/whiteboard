/**
 * The fourth reader of the one vocabulary: what a document should be
 * FINDABLE by when it shows an emoji instead of naming one.
 *
 * Measured before this existed, in the search package's own tokenizer:
 * `ship it 🚀 today` indexes as `["ship","it","today"]` and `🚀🔥` as `[]`.
 * A document whose point is the picture was findable by nothing.
 */
import { describe, expect, it } from 'vitest'
import { emojiSearchText } from './searchable.js'

/** The terms, as a set, so an assertion says what it means about order. */
const terms = (text: string): string[] => emojiSearchText(text).split(' ').filter(Boolean)

describe('an emoji lends the document its own names', () => {
  it('finds a raw emoji and answers with its shortcode, name and Japanese', () => {
    const found = terms('ship it 🚀 today')
    expect(found).toContain('rocket')
    expect(found).toContain('ロケット')
    // CLDR files it under a subgroup, which is a term a person types.
    expect(found).toContain('transport')
  })

  it('finds a written shortcode the same way', () => {
    const found = terms('build is :fire: right now')
    expect(found).toContain('fire')
    expect(found).toContain('炎')
  })

  /**
   * A multi-code-point sequence has to be matched WHOLE. Scanning code
   * points would find the base character of a flag or a ZWJ family and
   * answer with the wrong thing entirely.
   */
  it('matches a multi-code-point sequence as one thing', () => {
    expect(terms('👨‍👩‍👧 family photo')).toContain('family')
  })

  it('says nothing about text with no emoji and no shortcode in it', () => {
    expect(emojiSearchText('just some ordinary prose')).toBe('')
    expect(emojiSearchText('')).toBe('')
  })

  /** A colon pair naming no emoji is prose, exactly as the renderer treats it. */
  it('says nothing for a colon pair that names no emoji', () => {
    expect(emojiSearchText('see :something: at 10:30')).toBe('')
  })

  it('answers once for an emoji that appears twice', () => {
    const found = terms('🚀 and again 🚀')
    expect(found.filter((term) => term === 'rocket')).toEqual(['rocket'])
  })
})
