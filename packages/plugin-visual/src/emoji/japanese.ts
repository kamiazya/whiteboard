import { EMOJI_JA } from './catalog-ja.js'

/**
 * `character -> CLDR Japanese terms`, parsed once.
 *
 * Extracted because three readers wanted the identical six-line loop over
 * the same generated file — the picker's sections, the `:` completion's
 * index, and the search expander. Two copies were already there and the
 * third is what made it worth one definition: the parse is trivial, but a
 * copy that drifts in how it splits the row is a reader that quietly finds
 * less, which is the shape this whole index exists to prevent.
 *
 * Memoised for the same reason `sections.ts` memoises its rows: the table
 * is a frozen constant, so the answer cannot have changed.
 */
let parsed: ReadonlyMap<string, string> | undefined

export function emojiJapaneseTerms(): ReadonlyMap<string, string> {
  if (parsed !== undefined) return parsed
  const found = new Map<string, string>()
  for (const row of EMOJI_JA.split('\n')) {
    const tab = row.indexOf('\t')
    if (tab !== -1) found.set(row.slice(0, tab), row.slice(tab + 1))
  }
  parsed = found
  return parsed
}
