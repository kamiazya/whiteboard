/**
 * The two tables the Rust core lends a search index an emoji's names through
 * (`crates/core/plugin-visual`'s `emoji_search` module), generated here from
 * what `emojiSearchText` reads, so the vocabulary keeps one implementation:
 *
 * - `emoji-search-terms.tsv`: one `character<TAB>terms` row per catalog
 *   character, in catalog order, the terms as `emojiSearchTerms` holds them.
 * - `extended-pictographic.txt`: the code points this runtime's
 *   `\p{Extended_Pictographic}` matches, as `first..last` hex ranges. It is
 *   `emojiSearchText`'s gate, and a keycap or a flag is not in it, so the
 *   Rust gate has to be this set rather than "a grapheme the table names".
 *
 * Regenerate with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project plugin-visual-node emoji-search-table`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { emojiSearchTerms } from './searchable.js'

const TERMS = new URL('./emoji-search-terms.tsv', import.meta.url)
const PICTOGRAPHIC = new URL('./extended-pictographic.txt', import.meta.url)

const termRows = [...emojiSearchTerms()].map(([char, terms]) => `${char}\t${terms}`)

const hex = (code: number) => code.toString(16).toUpperCase().padStart(4, '0')

function pictographicRanges(): string[] {
  const ranges: string[] = []
  let first: number | undefined
  for (let code = 0; code <= 0x110000; code++) {
    const inside =
      code < 0x110000 &&
      !(code >= 0xd800 && code <= 0xdfff) &&
      /\p{Extended_Pictographic}/u.test(String.fromCodePoint(code))
    if (inside && first === undefined) first = code
    if (!inside && first !== undefined) {
      ranges.push(`${hex(first)}..${hex(code - 1)}`)
      first = undefined
    }
  }
  return ranges
}

const rangeRows = pictographicRanges()

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(TERMS, `${termRows.join('\n')}\n`)
  writeFileSync(PICTOGRAPHIC, `${rangeRows.join('\n')}\n`)
}

const committed = (file: URL) => readFileSync(file, 'utf8').trimEnd().split('\n')

describe('the emoji search tables the core reads', () => {
  it('holds every catalog character with the terms emojiSearchTerms gives it', () => {
    expect(termRows.length).toBeGreaterThanOrEqual(1500)
    expect(committed(TERMS)).toEqual(termRows)
  })

  it('holds the code points this runtime reads as Extended_Pictographic', () => {
    expect(rangeRows.length).toBeGreaterThan(50)
    expect(committed(PICTOGRAPHIC)).toEqual(rangeRows)
  })
})
