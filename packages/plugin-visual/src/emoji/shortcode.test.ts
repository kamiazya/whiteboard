/**
 * The read-path half of the shortcode vocabulary.
 *
 * `slug.ts` turns a CLDR name into what a person TYPES; this turns what they
 * typed back into the character, which is what every surface that draws a
 * body needs. The two are one vocabulary and must stay one — a shortcode the
 * picker inserts that the renderer does not resolve is the whole feature
 * failing silently, so the cases below check them against each other rather
 * than against a hand-written list.
 */
import { describe, expect, it } from 'vitest'
import { EMOJI_GROUPS } from './catalog-data.js'
import { emojiForShortcode, expandEmojiShortcodes } from './shortcode.js'
import { emojiSlug } from './slug.js'

const rows = EMOJI_GROUPS.flatMap(([, block]) =>
  block.split('\n').map((row) => {
    const [char, name] = row.split('\t')
    return { char: char as string, name: name as string }
  }),
)

describe('a shortcode resolves to the character the picker would have inserted', () => {
  /**
   * Over the WHOLE table rather than a sample: the two directions are
   * generated from one name, so a mismatch anywhere means the vocabulary has
   * split, and a sample would find that only by luck.
   */
  it('answers every row of the catalog by its own slug', () => {
    const missing = rows
      .filter((row) => emojiForShortcode(emojiSlug(row.name)) !== row.char)
      .map((row) => row.name)
    expect(missing).toEqual([])
    expect(rows.length).toBeGreaterThanOrEqual(1500)
  })

  it('answers nothing for a name that is not one', () => {
    expect(emojiForShortcode('not_an_emoji')).toBeUndefined()
    expect(emojiForShortcode('')).toBeUndefined()
  })
})

describe('expanding a body replaces shortcodes and leaves prose alone', () => {
  it('replaces a shortcode wherever it sits in the line', () => {
    expect(expandEmojiShortcodes(':grinning_face:')).toBe('😀')
    expect(expandEmojiShortcodes('ship it :rocket: today')).toBe('ship it 🚀 today')
    expect(expandEmojiShortcodes(':rocket::fire:')).toBe('🚀🔥')
  })

  /**
   * The case that decides whether this is safe to run over every document
   * ever written: a colon pair that is not a shortcode has to survive
   * BYTE-IDENTICAL, because the alternative is a renderer that quietly eats
   * text somebody wrote.
   */
  it('leaves a colon pair that names no emoji exactly as it was', () => {
    for (const text of [
      'see :something: here',
      'from 10:30: onwards',
      'a::b',
      ':: ::',
      'ratio 3:2 and 4:3',
      'https://example.com/a:b:c',
      'no colons at all',
      '',
    ]) {
      expect(expandEmojiShortcodes(text)).toBe(text)
    }
  })

  /**
   * A slug carries `_` and digits and nothing else, so a name with a space
   * or punctuation inside the colons is prose that happens to have two
   * colons in it — `:grinning face:` is a sentence, not a shortcode.
   */
  it('does not read prose between colons as a name', () => {
    expect(expandEmojiShortcodes(':grinning face:')).toBe(':grinning face:')
    expect(expandEmojiShortcodes(':rocket ship:')).toBe(':rocket ship:')
  })

  /** Nothing to expand is the common case, and it must not rebuild the string. */
  it('returns the same string it was given when there is nothing to do', () => {
    const text = 'an ordinary paragraph with no shortcodes in it'
    expect(expandEmojiShortcodes(text)).toBe(text)
  })
})
