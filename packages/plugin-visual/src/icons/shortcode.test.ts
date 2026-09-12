/**
 * The read-path half of the ICON vocabulary, and the sibling of
 * `emoji/shortcode.test.ts`.
 *
 * The one thing these two must agree on is that they never claim the same
 * span, so the disjointness property below is generated over text that
 * carries both kinds rather than asserted about the patterns in prose.
 */
import { describe, expect, it } from 'vitest'
import { emojiShortcodeRanges } from '../emoji/shortcode.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { BUILT_IN_ICON_NAMES } from './icons.js'
import { iconShortcodeRanges } from './shortcode.js'

const rangesOf = (text: string) => [...iconShortcodeRanges(text)]

describe('a shortcode resolves to an icon the renderer can actually draw', () => {
  it('finds every vendored name, and reports where it sits', () => {
    for (const name of BUILT_IN_ICON_NAMES) {
      expect(rangesOf(`before :icon-${name}: after`)).toEqual([
        { from: 7, to: 7 + `:icon-${name}:`.length, name },
      ])
    }
    expect(BUILT_IN_ICON_NAMES.length).toBeGreaterThanOrEqual(6)
  })

  it('finds nothing in a colon pair naming no vendored icon', () => {
    expect(rangesOf(':icon-no-such-icon:')).toEqual([])
    expect(rangesOf(':icon-:')).toEqual([])
    // The bare name is the EMOJI vocabulary's, and stays it.
    expect(rangesOf(':star:')).toEqual([])
  })

  it('finds every occurrence in one line, in order', () => {
    expect(rangesOf(':icon-star: and :icon-lock:').map((r) => r.name)).toEqual(['star', 'lock'])
  })
})

describe('the icon and emoji vocabularies claim disjoint spans', () => {
  /**
   * Structurally they cannot overlap — the icon pattern requires the hyphen
   * in `icon-`, which the emoji CANDIDATE's `[a-z0-9_]+` rejects — but that
   * is an argument about two regexes in two files, which is exactly the
   * thing that drifts. Generated over text carrying both kinds so the claim
   * is checked rather than reasoned.
   */
  const piece = fc.oneof(
    fc.constantFrom(...BUILT_IN_ICON_NAMES).map((name) => `:icon-${name}:`),
    fc.constantFrom(':star:', ':rocket:', ':grinning_face:', ':lock:'),
    fc.constantFrom(' ', 'x', '::', ':', '10:30', 'a-b', ':icon-:', ':icon-nope:'),
  )

  fcTest.prop([fc.array(piece, { maxLength: 12 })], withDefaults())(
    'never yield a span the other also yields',
    (pieces) => {
      const text = pieces.join('')
      const icons = [...iconShortcodeRanges(text)]
      const emoji = [...emojiShortcodeRanges(text)]
      for (const i of icons) {
        for (const e of emoji) {
          expect(i.from >= e.to || e.from >= i.to).toBe(true)
        }
      }
    },
  )

  fcTest.prop([fc.array(piece, { maxLength: 12 })], withDefaults())(
    'yield ascending, non-overlapping ranges whose text is the shortcode itself',
    (pieces) => {
      const text = pieces.join('')
      let previousTo = 0
      for (const range of iconShortcodeRanges(text)) {
        expect(range.from).toBeGreaterThanOrEqual(previousTo)
        expect(text.slice(range.from, range.to)).toBe(`:icon-${range.name}:`)
        expect(BUILT_IN_ICON_NAMES).toContain(range.name)
        previousTo = range.to
      }
    },
  )

  /**
   * The guard that stops both properties above passing vacuously: a
   * generator that never produced a resolvable shortcode would satisfy
   * them by having nothing to check.
   */
  it('generates text that actually carries both kinds', () => {
    const text = ':icon-star: :rocket: :icon-lock:'
    expect([...iconShortcodeRanges(text)].length).toBe(2)
    expect([...emojiShortcodeRanges(text)].length).toBe(1)
  })
})
