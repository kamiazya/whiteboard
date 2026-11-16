/**
 * `:icon-star:` -> the vendored star: the typing half of the ICON shortcode
 * vocabulary, for the editor's `:` completion. Where a shortcode sits in a
 * drawn body is the Rust core's scan (`crates/core/plugin-visual`), held to
 * `oracle/shortcode.jsonl`.
 *
 * The sibling of `emoji/shortcode.ts`, and deliberately a SEPARATE
 * vocabulary rather than a fallback inside that one: the names collide
 * (`star`, `lock`, `link` and `file` are all emoji shortcodes AND vendored
 * icon names), and an emoji is a CHARACTER while an icon is drawn geometry.
 * The `icon-` prefix is what keeps the two apart.
 */
import { compareCodeUnit } from '@kamiazya/whiteboard-model'
import { BUILT_IN_ICON_NAMES } from './icons.js'

/**
 * The names a typed query could mean, best first, for the editor's `:`
 * completion.
 *
 * Here rather than in a `search.ts` of its own — the emoji vocabulary splits
 * the two because its typing half drags a 190KB Japanese index the read path
 * must not carry. Six names have nothing to split.
 *
 * A leading `icon-` is STRIPPED before matching, so `:st` and `:icon-st`
 * find the same thing. That is the whole reach argument: a person typing a
 * colon does not know the prefix exists, and a vocabulary you have to know
 * the spelling of to discover is one nobody discovers.
 */
export function searchIconShortcodes(query: string): readonly string[] {
  const needle = query.replace(/^icon-?/, '').toLowerCase()
  if (needle === '') return BUILT_IN_ICON_NAMES
  const rank = (name: string): number =>
    name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : 3
  return BUILT_IN_ICON_NAMES.filter((name) => rank(name) < 3).sort(
    (a, b) => rank(a) - rank(b) || compareCodeUnit(a, b),
  )
}
