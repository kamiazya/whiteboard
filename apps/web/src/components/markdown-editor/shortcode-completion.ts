import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { renderSceneToSvg } from '@kamiazya/whiteboard-canvas-render'
import { searchIconShortcodes } from '@kamiazya/whiteboard-plugin-visual/icons/shortcode'

/**
 * `:` completion for BOTH shortcode vocabularies — emoji and vendored icons
 * — the typing half of the `:name:` syntax canvas-render draws.
 *
 * It inserts the SHORTCODE, not the character — `:rocket:`, which is what
 * the document stores (user decision, 2026-09-11) and what every body-drawing
 * surface resolves to 🚀. Inserting the character instead would make this a
 * different feature with the same gesture. For an icon there is no character
 * to insert at all, which is half of why the two are separate vocabularies.
 *
 * Shaped after `wiki-link-completion.ts`, and the two load-bearing parts are
 * the same for the same reasons: `from` points AFTER the trigger so the
 * plugin's own filter has the query to score against, and `apply` re-derives
 * the trigger's position from the `from` the plugin passes rather than from
 * anything captured when the source ran — the document can change in between
 * (mobile autocorrect, a CRDT remote echo), and a stale offset writes into
 * the middle of a word.
 *
 * ASYNC, unlike that one. The search index is `catalog-ja.ts` as well as the
 * rows — 190KB whose whole point is to stay out of graphs that do not open a
 * picker — so it arrives through a dynamic import on first use. A person who
 * never types a colon never loads it. CodeMirror accepts a promise from a
 * completion source, so nothing else has to know.
 */

/**
 * At least two characters after the colon. The character class is exactly
 * what the two shortcode vocabularies can produce between them — `_` is the
 * emoji half's, `-` the icon half's — so anything it matches is a name that
 * could exist, and a lone `:` does not open a list of 1914 rows.
 *
 * The hyphen is load-bearing rather than tidy. Without it the popup did not
 * merely omit icons: `:icon-` matched NOTHING, so the list a person already
 * had open vanished at the moment they typed the character that would have
 * narrowed it.
 */
const TRIGGER = /:[a-z0-9_-]{2,}$/

/**
 * A shortcode's colon opens a WORD. Anything alphanumeric before it means
 * the colon is punctuation inside one — a time, a ratio, a URL scheme,
 * `key:value`.
 *
 * This is the check that actually keeps the popup out of prose, and it
 * exists because the obvious reasoning was wrong: `10:30` was expected to
 * reach `:30`, match nothing and close on its own. Measured, it opens a
 * list — the search reads each row's subgroup and Japanese terms too, and
 * plenty of those contain `30`. A trigger cannot rely on the index being
 * empty for text that is not a name.
 */
const OPENS_A_WORD = /[a-z0-9]/i

/** How many rows the list offers; `searchEmojiShortcodes` bounds its own. */
const LIMIT = 20

/**
 * Replace the trigger — the colon and everything typed after it — with the
 * finished shortcode.
 *
 * The position is re-derived from the `from` the plugin passes rather than
 * from anything captured when the source ran: the document can change in
 * between (mobile autocorrect, a CRDT remote echo), and a stale offset writes
 * into the middle of a word.
 */
function applyShortcode(shortcode: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const colonFrom = from - 1
    if (view.state.sliceDoc(colonFrom, from) !== ':') return
    const insert = `:${shortcode}:`
    view.dispatch({
      changes: { from: colonFrom, to, insert },
      selection: { anchor: colonFrom + insert.length },
      userEvent: 'input.complete',
    })
  }
}

/**
 * SECTIONS, not `boost`, are what put the six icons above the 1914 emoji —
 * and the difference is not a preference, it is the only thing that works.
 *
 * Measured in a real browser: with `boost` alone the icon row was BUILT and
 * then sorted out of the visible list, because CodeMirror scores an option
 * as `match.score + boost` and charges -700 for a pattern that does not
 * match at the start of the label. `st` finds `icon-star` at offset 5, so no
 * boost inside the documented range can climb back. A section instead shifts
 * every option in it by -1e5 in rank order, which dominates the penalty.
 *
 * That is also why the EMOJI rows need a section of their own: an option
 * with no section is shifted by nothing, so it outranks every sectioned one.
 *
 * The heading it draws is a gain rather than a cost, and the reason this
 * slice exists: a vocabulary a person has to already know the spelling of is
 * one nobody discovers, and the list now says out loud that icons are there.
 */
const ICON_PREFIX = 'icon-'
const ICON_SECTION = { name: 'Icons', rank: 0 }
const EMOJI_SECTION = { name: 'Emoji', rank: 1 }

/**
 * The icon as it appears ON ITS ROW, where an emoji row shows its character.
 *
 * Drawn by the SAME producer that will draw it in the body — a one-node
 * scene through `renderSceneToSvg`. Not hand-built markup: a second emitter
 * of an icon `<use>` is two places for a set's viewBox and paint convention
 * to be got wrong, which is the reason `svg/icon.ts` exists at all.
 *
 * `currentColor` rather than a fixed stroke, so the glyph follows the row —
 * including the selected row, which paints `--accent-foreground`. That is
 * also why this is real DOM and not a CSS `background-image`: a background
 * image is an isolated document and cannot see the colour it sits on.
 */
function iconGlyph(name: string): HTMLElement {
  const host = document.createElement('span')
  host.className = 'cm-completionIcon-wb-icon'
  host.setAttribute('aria-hidden', 'true')
  host.innerHTML = renderSceneToSvg(
    { nodes: [{ kind: 'icon', bbox: { x: 0, y: 0, w: 16, h: 16 }, icon: name }] },
    { width: 16, height: 16, viewBox: { x: 0, y: 0, w: 16, h: 16 } },
  )
  host.firstElementChild?.setAttribute('stroke', 'currentColor')
  return host
}

/**
 * Draws that glyph in the row's own gutter, the slot CodeMirror gives every
 * option (`.cm-completionIcon`, position 20) and this app hides because the
 * generic kind icon says nothing. Position 30 puts it after that slot and
 * before the label, which is where an emoji row's character sits.
 *
 * Passed to each host's `autocompletion()` rather than installed as an
 * extension of its own: `completionConfig` is not exported, and a second
 * `autocompletion()` call beside the first would replace its `override`.
 */
export const shortcodeOptionRenderers = [
  {
    render: (completion: Completion): Node | null =>
      completion.label.startsWith(ICON_PREFIX)
        ? iconGlyph(completion.label.slice(ICON_PREFIX.length))
        : null,
    position: 30,
  },
]

/**
 * The icon rows. Synchronous, unlike the emoji half: six strings, with no
 * index to fetch.
 *
 * The label keeps the `icon-` prefix so BOTH ways in score well — `icon-st`
 * matches it at the start, and `st` matches inside it, which the section
 * then lifts. Labelling the row `star` instead would read better for the
 * second and make the first match nothing at all.
 */
function iconOptions(query: string): Completion[] {
  const names = searchIconShortcodes(query)
  return names.map((name, index) => ({
    label: `${ICON_PREFIX}${name}`,
    detail: 'drawn, not a character',
    section: ICON_SECTION,
    boost: names.length - index,
    apply: applyShortcode(`${ICON_PREFIX}${name}`),
  }))
}

export function shortcodeCompletionSource(
  context: CompletionContext,
): Promise<CompletionResult | null> | null {
  const match = context.matchBefore(TRIGGER)
  if (match === null) return null
  if (OPENS_A_WORD.test(context.state.sliceDoc(Math.max(0, match.from - 1), match.from)))
    return null
  const query = match.text.slice(1)
  const icons = iconOptions(query)
  return (async () => {
    const { searchEmojiShortcodes } = await import(
      '@kamiazya/whiteboard-plugin-visual/emoji/search'
    )
    const found = searchEmojiShortcodes(query, LIMIT)
    if (found.length === 0 && icons.length === 0) return null
    return {
      from: match.from + 1,
      options: icons.concat(
        found.map(
          (row, index): Completion => ({
            // The plugin filters and re-scores against `label`, so it has to be
            // the bare shortcode; `boost` is what keeps this module's own ranking
            // (exact name first) from being reshuffled by that scoring.
            label: row.shortcode,
            displayLabel: `${row.char} ${row.shortcode}`,
            // Only where the CLDR name says something the shortcode does not.
            // `flag_morocco` is worth captioning `flag: Morocco`; `rock`
            // captioned `rock` is the same word twice on a row already showing
            // the character, which is what the popup looked like at first.
            ...(row.name === row.shortcode.replace(/_/g, ' ') ? {} : { detail: row.name }),
            section: EMOJI_SECTION,
            boost: LIMIT - index,
            apply: applyShortcode(row.shortcode),
          }),
        ),
      ),
      // A growing name keeps this result; the closing colon ends the grammar
      // and re-asks the source, which then matches nothing and closes — so
      // typing `:rocket:` by hand does not leave a list open over the line.
      validFor: /^[a-z0-9_-]*$/,
    }
  })()
}
