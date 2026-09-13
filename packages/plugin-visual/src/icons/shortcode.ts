/**
 * `:icon-star:` -> the vendored star, for every surface that DRAWS a body.
 *
 * The sibling of `emoji/shortcode.ts`, and deliberately a SEPARATE
 * vocabulary rather than a fallback inside that one. Two reasons, both
 * measured against the alternative:
 *
 * - The names collide. `star`, `lock`, `link` and `file` are all emoji
 *   shortcodes AND vendored icon names, so a bare `:star:` resolving to
 *   whichever table answered first is a coin toss a reader cannot predict
 *   from the source.
 * - An emoji is a CHARACTER and an icon is drawn geometry, so the two
 *   cannot share a substitution either. `expandEmojiShortcodes` returns a
 *   string; there is no string an icon expands to, which is why this module
 *   offers ranges and no expander.
 *
 * The prefix is what keeps the two apart, and it does so structurally: the
 * emoji pattern is `[a-z0-9_]+`, which cannot match the hyphen in `icon-`.
 * `shortcode.test.ts` generates text carrying both kinds and checks the
 * spans stay disjoint, because that is a claim about two regexes in two
 * files and those drift.
 */
import { BUILT_IN_ICON_NAMES } from './icons.js'

/**
 * What an icon shortcode may be spelled with: the lucide naming vocabulary,
 * which is lowercase letters, digits and `-`.
 *
 * As with the emoji pattern, what makes this safe over arbitrary prose is
 * the LOOKUP failing rather than the match never happening — `:icon-foo:`
 * matches and resolves to nothing, and the text is left as written.
 */
const CANDIDATE = /:icon-([a-z0-9-]+):/g

let names: ReadonlySet<string> | undefined

/**
 * The nameable set is `BUILT_IN_ICON_NAMES`, NOT every icon the plugin
 * registers. Edge glyphs and emoji-category glyphs are registered geometry
 * that is deliberately not a badge anyone can choose (see `data.ts`), and a
 * body naming one would put a picture of a routing style in a sentence.
 */
function nameable(): ReadonlySet<string> {
  names ??= new Set(BUILT_IN_ICON_NAMES)
  return names
}

/** One icon shortcode found in a run of text: where it sits, and what it draws. */
export interface IconShortcodeRange {
  /** Index of the opening colon. */
  readonly from: number
  /** Index just past the closing colon. */
  readonly to: number
  /** The vendored icon's name, as `paints.name` and `IconSceneNode.icon` spell it. */
  readonly name: string
}

/**
 * Every `:icon-name:` a run of text actually resolves, in order.
 *
 * As with the emoji ranges, this exists so WHERE a shortcode is has one
 * definition: the renderer replaces these ranges while drawing, and an
 * editor that previews them must read the same ones or it shows a person
 * something the renderer will not do.
 *
 * A colon pair naming no vendored icon is not a range.
 */
export function* iconShortcodeRanges(text: string): Generator<IconShortcodeRange> {
  // Exact, not merely cheap: every match contains this literal, so a body
  // without it has none — and that is almost every body.
  if (!text.includes(':icon-')) return
  for (const match of text.matchAll(CANDIDATE)) {
    const name = match[1] as string
    if (!nameable().has(name)) continue
    const from = match.index
    yield { from, to: from + match[0].length, name }
  }
}

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
    (a, b) => rank(a) - rank(b) || a.localeCompare(b),
  )
}
