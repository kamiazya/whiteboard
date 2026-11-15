/**
 * The two shortcode vocabularies a drawn body reads, recorded for the Rust
 * scans to replay (`crates/core/plugin-visual/tests/shortcode_oracle.rs`):
 * per text, what `expandEmojiShortcodes` makes of it and the ranges
 * `iconShortcodeRanges` answers, offsets in UTF-16 code units as the
 * typesetter is handed them.
 *
 * The texts are hand-written cases and a seeded stream built from fragments
 * that sit on the scans' edges: real slugs and icon names, the same names
 * one character off, colons in runs, `icon-` with and without a name, a
 * digit-only pair (`10:30:`), case, newlines and characters outside the
 * Basic Multilingual Plane, so an offset that counts code points or bytes
 * instead of code units parts from the recording.
 */
import { randomFrom } from '@kamiazya/whiteboard-model/test-utils'
import { EMOJI_GROUPS } from '../emoji/catalog-data.js'
import { expandEmojiShortcodes } from '../emoji/shortcode.js'
import { emojiSlug } from '../emoji/slug.js'
import { BUILT_IN_ICON_NAMES } from '../icons/icons.js'
import { iconShortcodeRanges } from '../icons/shortcode.js'

export interface ShortcodeLine {
  readonly in: string
  /** `expandEmojiShortcodes(in)`. */
  readonly emoji: string
  /** `iconShortcodeRanges(in)` as `[from, to, name]`. */
  readonly icons: ReadonlyArray<readonly [number, number, string]>
}

const HAND_WRITTEN: readonly string[] = [
  '',
  'plain words',
  'one: colon',
  ':rocket:',
  'ship it :rocket: today',
  ':rocket::fire:',
  ':rocket:fire:',
  ':not_an_emoji: :rocket:',
  ':not_an_emoji:rocket:',
  'at 10:30: we meet',
  '3:2 and 10:30:45',
  ':grinning face: is not one',
  ':Rocket: is not one either',
  ':star: and :icon-star: and :icon-lock:',
  ':icon-star::icon-lock:',
  ':icon-:',
  ':icon-no-such-icon:',
  ':icon-star',
  'icon-star:',
  '::icon-star::',
  ':icon-icon-star:',
  ':icon-Star:',
  ':icon_star:',
  '😀 :icon-database: 😀 :rocket:',
  '𝒳:icon-link:𝒳:keycap_hash:',
  ':flag_japan: :keycap_asterisk: :thumbs_up:',
  'http://example.com:8080/path',
  'a:b:c:d:e',
  ':::',
  ':_:',
  ':-:',
  'line one :rocket\n: line two :fire:',
  ':icon-star:\n:icon-star:',
  '`:rocket:` is a code span only to markdown',
]

/** Fragments the seeded stream joins: names on the edge of each table, and the text around them. */
function fragments(): string[] {
  const slugs = EMOJI_GROUPS.flatMap(([, block]) =>
    block.split('\n').map((row) => emojiSlug(row.split('\t')[1] ?? '')),
  )
  const sampled = slugs.filter((_, i) => i % 37 === 0)
  const names = [...BUILT_IN_ICON_NAMES]
  return [
    ...sampled,
    ...sampled.map((slug) => `${slug}x`),
    ...names,
    ...names.map((name) => `icon-${name}`),
    ...names.map((name) => `icon-${name}s`),
    'icon-',
    'icon',
    'star',
    'icon-star',
    'icon-user',
    '10',
    '30',
    'a_b',
    'a-b',
    'A',
    'é',
    '日本',
    '😀',
    '𝒳',
    ' ',
    '\n',
    '-',
    '_',
  ]
}

const COLONS = [':', ':', ':', '::', ''] as const

/** The seeded stream: `count` texts, each a few fragments joined by colons or nothing. */
function seededTexts(count: number): string[] {
  const parts = fragments()
  const next = randomFrom(0x5e0c_0de5)
  const pick = <T>(from: readonly T[]): T => from[Math.floor(next() * from.length)] as T
  const texts: string[] = []
  for (let i = 0; i < count; i++) {
    let text = ''
    const length = 1 + Math.floor(next() * 6)
    for (let j = 0; j < length; j++) text += pick(COLONS) + pick(parts)
    texts.push(next() < 0.5 ? `${text}:` : text)
  }
  return texts
}

export function shortcodeLineOf(text: string): ShortcodeLine {
  return {
    in: text,
    emoji: expandEmojiShortcodes(text),
    icons: [...iconShortcodeRanges(text)].map(({ from, to, name }) => [from, to, name] as const),
  }
}

/** Every recorded text, in order. */
export function recordShortcodeLines(): ShortcodeLine[] {
  return [...HAND_WRITTEN, ...seededTexts(1500)].map(shortcodeLineOf)
}
