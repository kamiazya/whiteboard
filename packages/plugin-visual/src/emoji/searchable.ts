/**
 * What a document should be FINDABLE by when it SHOWS a thing rather than
 * naming it.
 *
 * The fourth reader of one vocabulary — `slug.ts` writes the name,
 * `shortcode.ts` resolves it while drawing, `search.ts` offers it while
 * typing, and this lends it to a search index. All four derive from
 * `EMOJI_GROUPS` through `emojiSlug`, so what a person can find a rocket by
 * cannot drift from what the picker inserted or what the renderer draws.
 *
 * Measured before this existed, in the search package's own tokenizer: the
 * word pattern is `[\p{L}\p{N}]+`, and an emoji is neither a letter nor a
 * number — so `ship it 🚀 today` indexes as `["ship","it","today"]` and
 * `🚀🔥` as `[]`. A document whose point is the picture was findable by
 * nothing at all. `:rocket:` was the one exception and an accidental one:
 * the colons are not word characters, so the run `rocket` fell out, which
 * is why the English spelling already worked and the Japanese never did.
 *
 * It answers TEXT rather than tokens, and that is deliberate. The index's
 * scheme — latin words lowercased, CJK as adjacent bigrams plus unigrams —
 * is `packages/search`'s to own, and a caller handing it tokens would be a
 * second place that decides how 「ロケット」 is cut up.
 */
import { EMOJI_GROUPS } from './catalog-data.js'
import { emojiJapaneseTerms } from './japanese.js'
import { emojiShortcodeRanges } from './shortcode.js'
import { emojiSlug } from './slug.js'

/**
 * Anything that could be an emoji at all, so ordinary prose costs one regex
 * and stops. `Extended_Pictographic` is the Unicode property for exactly
 * this question, and it is far cheaper than segmenting every document.
 */
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u

let table: Map<string, string> | undefined

/** `character -> everything that character can be found by`. */
function terms(): Map<string, string> {
  if (table !== undefined) return table
  const ja = emojiJapaneseTerms()
  const found = new Map<string, string>()
  for (const [, block] of EMOJI_GROUPS) {
    for (const row of block.split('\n')) {
      const [char, name, subgroup] = row.split('\t')
      if (char === undefined || name === undefined) continue
      // The subgroup earns its place the same way it does in the picker's
      // search: `transport` reaches 85 rows that say so nowhere else.
      // Hyphens become spaces so `transport-air` is two terms, since the
      // index splits on non-word characters anyway.
      // Deduplicated WORD-wise, not part-wise. `emojiSlug('rocket')` is
      // `rocket`, so a single-word name emits the same term twice — and a
      // repeated term is a higher term frequency, which would score a
      // document that merely SHOWS a rocket above one that writes the word.
      // Measured: `🚀` answered `['rocket', 'rocket']` before this.
      const parts = [emojiSlug(name), name, (subgroup ?? '').replaceAll('-', ' '), ja.get(char)]
      found.set(char, [...new Set(parts.join(' ').split(/\s+/).filter(Boolean))].join(' '))
    }
  }
  table = found
  return table
}

/**
 * Every emoji a run of text shows, matched as GRAPHEMES.
 *
 * 730 of the 1914 rows are more than one code point — flags, keycaps, ZWJ
 * families — and scanning code points would match a base character and
 * answer with the wrong thing entirely. A grapheme cluster is what a
 * fully-qualified sequence already is, so the segmenter does the
 * longest-match that would otherwise have to be hand-rolled.
 */
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' })

/**
 * The extra text a document's own content earns it, or `''`.
 *
 * Each emoji contributes once however often it appears: this is vocabulary
 * the document gains, not evidence of emphasis, and repeating it would let
 * a row of party poppers outrank a document that is about the party.
 */
export function emojiSearchText(text: string): string {
  const pictographic = PICTOGRAPHIC.test(text)
  if (!pictographic && !text.includes(':')) return ''

  const table = terms()
  const found = new Set<string>()
  if (pictographic) {
    for (const { segment } of graphemes.segment(text)) {
      const row = table.get(segment)
      if (row !== undefined) found.add(row)
    }
  }
  for (const range of emojiShortcodeRanges(text)) {
    const row = table.get(range.char)
    if (row !== undefined) found.add(row)
  }
  return [...found].join(' ')
}
