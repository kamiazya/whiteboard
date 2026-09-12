import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'

/**
 * `:` completion for emoji shortcodes, the typing half of the `:name:`
 * syntax canvas-render draws.
 *
 * It inserts the SHORTCODE, not the character — `:rocket:`, which is what
 * the document stores (user decision, 2026-09-11) and what every body-drawing
 * surface resolves to 🚀. Inserting the character instead would make this a
 * different feature with the same gesture.
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
 * what the shortcode vocabulary can produce, so anything it matches is a
 * name that could exist, and a lone `:` does not open a list of 1914 rows.
 */
const TRIGGER = /:[a-z0-9_]{2,}$/

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

export function emojiCompletionSource(
  context: CompletionContext,
): Promise<CompletionResult | null> | null {
  const match = context.matchBefore(TRIGGER)
  if (match === null) return null
  if (OPENS_A_WORD.test(context.state.sliceDoc(Math.max(0, match.from - 1), match.from)))
    return null
  const query = match.text.slice(1)
  return (async () => {
    const { searchEmojiShortcodes } = await import(
      '@kamiazya/whiteboard-plugin-visual/emoji/search'
    )
    const found = searchEmojiShortcodes(query, LIMIT)
    if (found.length === 0) return null
    return {
      from: match.from + 1,
      options: found.map(
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
          boost: LIMIT - index,
          apply: (view: EditorView, _completion, from, to) => {
            const colonFrom = from - 1
            if (view.state.sliceDoc(colonFrom, from) !== ':') return
            const insert = `:${row.shortcode}:`
            view.dispatch({
              changes: { from: colonFrom, to, insert },
              selection: { anchor: colonFrom + insert.length },
              userEvent: 'input.complete',
            })
          },
        }),
      ),
      // A growing name keeps this result; the closing colon ends the grammar
      // and re-asks the source, which then matches nothing and closes — so
      // typing `:rocket:` by hand does not leave a list open over the line.
      validFor: /^[a-z0-9_]*$/,
    }
  })()
}
