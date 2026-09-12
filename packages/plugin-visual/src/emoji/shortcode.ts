/**
 * `:grinning_face:` -> 😀, for every surface that DRAWS a body.
 *
 * The other half of `slug.ts`. That one turns a CLDR name into what a person
 * types; this turns what they typed back into the character. They are one
 * vocabulary read in two directions, which is why this derives its table
 * from the same `EMOJI_GROUPS` rows through the same `emojiSlug` rather than
 * from a generated index of its own: a second table is a second thing to
 * regenerate, and the day it lags the picker inserts a shortcode the
 * renderer will not resolve — the whole feature failing silently, in a
 * document that already has the text in it.
 *
 * That costs the read path this package's 69KB row table. Deliberate, and
 * measured against the alternative: a slug-only table is 39KB, so a separate
 * one buys 30KB and pays for it with the drift class above. What it does NOT
 * pull in is `catalog-ja.ts` (118KB) — that is a picker's search index and
 * nothing draws with it, so this module imports `catalog-data.js` directly
 * rather than `sections.js`, which reaches both.
 *
 * Unlike the picker's rows this is not behind a dynamic import, and the
 * reason is what NEEDS it rather than how big it is. A picker's table is
 * read when a person opens a panel, so a renderer that never opens one
 * should not carry it. A shortcode's table is read to draw a paragraph, and
 * every realm that draws one — the layout worker, the SVG renderer, the MCP
 * server's export — has to resolve the same `:name:` to the same character
 * or the same document renders differently depending on who drew it. A
 * promise cannot be awaited inside a synchronous inline walk anyway.
 *
 * The MAP is still lazy, and gated on a candidate: a body with no `:x:` in
 * it never builds it, which is almost every body.
 */
import { EMOJI_GROUPS } from './catalog-data.js'
import { emojiSlug } from './slug.js'

/**
 * What a shortcode may be spelled with, and it is exactly what `emojiSlug`
 * can produce: lowercase letters, digits and `_`.
 *
 * It is NOT what makes this safe to run over every document ever written,
 * and saying so here because the first version of this comment claimed it
 * was. Widening it to `:([^:]+):` passes every case in `shortcode.test.ts`,
 * measured — because what protects `:grinning face:`, `10:30:` and `3:2` is
 * the LOOKUP failing and the match being returned whole, not the match
 * never happening. A pattern can only be as safe as the table behind it.
 *
 * What the narrowness actually buys is cost and legibility: prose stops
 * being a candidate before any allocation, `[^:]+` spans newlines so a
 * two-colon paragraph would match the whole thing, and the pattern states
 * the vocabulary in the one place a reader looks for it.
 */
const CANDIDATE = /:([a-z0-9_]+):/g

let table: Map<string, string> | undefined

function shortcodes(): Map<string, string> {
  if (table !== undefined) return table
  const found = new Map<string, string>()
  for (const [, block] of EMOJI_GROUPS) {
    for (const row of block.split('\n')) {
      const tab = row.indexOf('\t')
      const second = row.indexOf('\t', tab + 1)
      const char = row.slice(0, tab)
      const name = second === -1 ? row.slice(tab + 1) : row.slice(tab + 1, second)
      // FIRST wins. `catalog.test.ts` asserts every slug over the table is
      // distinct, so today nothing is dropped here; the guard is for the
      // Unicode release that introduces a collision, where resolving to the
      // earlier CLDR row beats resolving to whichever happened to be last.
      const slug = emojiSlug(name)
      if (!found.has(slug)) found.set(slug, char)
    }
  }
  table = found
  return table
}

/** The character a shortcode names, or `undefined` when it names none. */
export function emojiForShortcode(slug: string): string | undefined {
  if (slug === '') return undefined
  return shortcodes().get(slug)
}

/** One shortcode found in a run of text: where it sits, and what it draws. */
export interface EmojiShortcodeRange {
  /** Index of the opening colon. */
  readonly from: number
  /** Index just past the closing colon. */
  readonly to: number
  readonly char: string
}

/**
 * Every `:name:` a run of text actually resolves, in order.
 *
 * This exists so that WHERE a shortcode is has one definition. The renderer
 * replaces these ranges while drawing; the editor draws a widget over the
 * same ones so a person sees, in the source, exactly what the render will
 * make of it. Two scanners would drift, and the drift would be the worst
 * shape available — an editor that previews something the renderer does not
 * do.
 *
 * A colon pair naming no emoji is not a range: what protects prose is this
 * lookup failing, the same as it always was.
 */
export function* emojiShortcodeRanges(text: string): Generator<EmojiShortcodeRange> {
  // Cheaper than the regex on the overwhelmingly common no-colon body, and
  // it is the gate that keeps the table unbuilt for those.
  if (!text.includes(':')) return
  for (const match of text.matchAll(CANDIDATE)) {
    const char = shortcodes().get(match[1] as string)
    if (char === undefined) continue
    const from = match.index
    yield { from, to: from + match[0].length, char }
  }
}

/**
 * Every `:name:` in a run of text replaced by its character, and everything
 * else — including a colon pair that names no emoji — returned untouched.
 *
 * Returns the SAME string when there is nothing to do, which is the common
 * case and the reason the table is not built until a candidate appears.
 */
export function expandEmojiShortcodes(text: string): string {
  let expanded: string | undefined
  let at = 0
  for (const range of emojiShortcodeRanges(text)) {
    expanded = (expanded ?? '') + text.slice(at, range.from) + range.char
    at = range.to
  }
  return expanded === undefined ? text : expanded + text.slice(at)
}
