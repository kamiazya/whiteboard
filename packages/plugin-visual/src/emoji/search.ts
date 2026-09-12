/**
 * Finding a shortcode by what somebody types after a `:`.
 *
 * The third reader of one vocabulary: `slug.ts` writes the name, `shortcode.ts`
 * resolves it while drawing, and this offers it while typing. All three
 * derive from `EMOJI_GROUPS` through `emojiSlug`, so a completion cannot
 * offer a name the renderer will not resolve — which would be the feature
 * failing in the one place nobody would think to check, and is what
 * `search.test.ts` asserts directly rather than trusting.
 *
 * It reads the JAPANESE index too, so this module costs `catalog-ja.ts`'s
 * 118KB. That is why it is separate from `shortcode.ts`: the renderer's
 * table has to be on the read path, and a search index has no business
 * there. An editor reaches this one by DYNAMIC import, so a person who never
 * types a colon never pays for it.
 */
import { EMOJI_GROUPS } from './catalog-data.js'
import { emojiJapaneseTerms } from './japanese.js'
import { emojiSlug } from './slug.js'

export interface EmojiShortcodeMatch {
  /** What goes between the colons. */
  readonly shortcode: string
  /** The character it draws as. */
  readonly char: string
  /** CLDR's short name, for a completion list's detail column. */
  readonly name: string
}

interface Row extends EmojiShortcodeMatch {
  /** Everything this row can be found by, lowercased and space-joined. */
  readonly terms: string
}

let rows: readonly Row[] | undefined

function index(): readonly Row[] {
  if (rows !== undefined) return rows
  const ja = emojiJapaneseTerms()
  rows = EMOJI_GROUPS.flatMap(([, block]) =>
    block.split('\n').map((row): Row => {
      const [char, name, subgroup] = row.split('\t')
      const shortcode = emojiSlug(name as string)
      return {
        shortcode,
        char: char as string,
        name: name as string,
        terms:
          `${shortcode} ${name} ${subgroup ?? ''} ${ja.get(char as string) ?? ''}`.toLowerCase(),
      }
    }),
  )
  return rows
}

/**
 * How well a row answers a query, higher first. `0` means it does not.
 *
 * Ranked rather than filtered because a completion list is read top-down and
 * the exact name has to be the first row: a plain substring filter would put
 * whichever row came first in CLDR order at the top and bury the one that
 * was typed.
 */
function rank(row: Row, query: string): number {
  if (row.shortcode === query) return 4
  if (row.shortcode.startsWith(query)) return 3
  if (row.shortcode.includes(query)) return 2
  return row.terms.includes(query) ? 1 : 0
}

/**
 * The rows a query names, best first, at most `limit` of them.
 *
 * Bounded because the source is 1914 rows and a completion list is read at a
 * glance; an unbounded answer would have CodeMirror render all of them.
 */
export function searchEmojiShortcodes(query: string, limit = 20): readonly EmojiShortcodeMatch[] {
  const wanted = query.trim().toLowerCase()
  if (wanted === '') return []
  const scored: Array<{ row: Row; score: number }> = []
  for (const row of index()) {
    const score = rank(row, wanted)
    if (score > 0) scored.push({ row, score })
  }
  // Score first, then the SHORTER shortcode, then CLDR order (`sort` is stable,
  // and CLDR order is the order a keyboard shows them in).
  //
  // Length is not a tie-break detail, it is what makes a prefix usable:
  // `:ro` scores `rocket` and `rolling_on_the_floor_laughing` alike, and on
  // CLDR order alone the laughing face wins because Smileys is the first
  // group. Measured against the first version of this file, which is what
  // the test asserting `:rocke` -> `rocket` is really pinning.
  scored.sort((a, b) => b.score - a.score || a.row.shortcode.length - b.row.shortcode.length)
  return scored.slice(0, limit).map(({ row }) => ({
    shortcode: row.shortcode,
    char: row.char,
    name: row.name,
  }))
}
