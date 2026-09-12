/**
 * What a `:` completion offers while somebody is typing a name.
 *
 * The same vocabulary the picker searches and the renderer resolves — a
 * third index would be a third thing to keep in step, and the failure would
 * be a completion offering a shortcode the renderer draws as literal text.
 */
import { describe, expect, it } from 'vitest'
import { searchEmojiShortcodes } from './search.js'
import { emojiForShortcode } from './shortcode.js'

const codes = (query: string) => searchEmojiShortcodes(query).map((match) => match.shortcode)

describe('typing a name after a colon finds the emoji it names', () => {
  it('puts an exact name first, ahead of the longer names containing it', () => {
    expect(codes('rocket')[0]).toBe('rocket')
    expect(codes('fire')[0]).toBe('fire')
  })

  it('completes a prefix', () => {
    expect(codes('roc')).toContain('rocket')
    expect(codes('grinning')).toContain('grinning_face')
  })

  /**
   * The gap the CLDR vocabulary leaves: `:white_check_mark:` names nothing,
   * so the completion has to be how a person finds ✅ at all. Typing the
   * word they actually mean must reach it.
   */
  it('reaches a CLDR name through the word a person would type', () => {
    expect(codes('check')).toContain('check_mark_button')
    expect(codes('thumbs')).toContain('thumbs_up')
  })

  /** CLDR's Japanese index is the picker's, and it is the same one here. */
  it('matches Japanese terms, as the picker does', () => {
    const found = searchEmojiShortcodes('ロケット')
    expect(found.map((match) => match.char)).toContain('🚀')
  })

  it('answers nothing rather than everything for a name nobody has', () => {
    expect(searchEmojiShortcodes('zzzznotathing')).toEqual([])
  })

  /**
   * A completion list is read at a glance, and the source is 1914 rows. An
   * unbounded answer would push CodeMirror into rendering all of them.
   */
  it('bounds what it returns', () => {
    expect(searchEmojiShortcodes('a').length).toBeLessThanOrEqual(20)
    expect(searchEmojiShortcodes('a', 5).length).toBeLessThanOrEqual(5)
  })

  /**
   * The contract that makes the completion safe to wire at all: every slug
   * it offers is one the renderer resolves. A match the projection would
   * draw as literal text is the feature failing in the one place a person
   * would not think to check.
   */
  it('offers only names the renderer resolves, and to the same character', () => {
    const broken = ['a', 'e', 'i', 'face', 'check', 'ロケット', '星']
      .flatMap((query) => searchEmojiShortcodes(query))
      .filter((match) => emojiForShortcode(match.shortcode) !== match.char)
    expect(broken).toEqual([])
  })

  it('says nothing for an empty query', () => {
    expect(searchEmojiShortcodes('')).toEqual([])
  })
})
