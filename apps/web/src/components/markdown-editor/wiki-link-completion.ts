import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { type LinkTarget, linkMarkupFor, rankLinkTargets } from './link-target.js'

/**
 * `[[` completion for document references. Accepting a candidate writes the
 * same markup the Link picker would (`linkMarkupFor`) — readable `[[Name]]`
 * when unique, `[[<id>|Name]]` otherwise — so the two entry points cannot
 * teach different link spellings.
 *
 * `from` points AFTER the `[[`, at the query, and each option's `apply` is a
 * function that replaces the brackets too. That split is load-bearing, twice
 * over: the plugin's default filter matches labels against the text from
 * `from` (a `from` at the brackets scored every option zero and silently
 * discarded the result), and `validFor` keeps ONE result alive while the
 * query grows. The earlier shape — `filter: false`, no `validFor` — re-ran
 * the source on every keystroke, and each re-query re-stamped the open
 * result, so acceptCompletion's interactionDelay guard (Enter within 75ms
 * of the result opening is treated as an accident and falls through to a
 * newline) could reject a fast Enter indefinitely. With validFor the stamp
 * is set once when `[[` opens the list and fast typing cannot push it
 * forward.
 *
 * Targets arrive through a getter rather than being captured: the document
 * list refreshes while the editor lives, and a completion source is built
 * once at view creation.
 */
export function wikiLinkCompletionSource(getTargets: () => readonly LinkTarget[]) {
  return (context: CompletionContext): CompletionResult | null => {
    // The open [[ with whatever partial query follows it. `matchBefore` only
    // looks at the current line, so a reference cannot span a line break —
    // the same rule the codec scanner enforces on read.
    const match = context.matchBefore(/\[\[[^\][|]*$/)
    if (match === null) return null
    const targets = getTargets()
    if (targets.length === 0) return null
    const bracketsFrom = match.from
    const ranked = rankLinkTargets(targets, match.text.slice(2))
    if (ranked.length === 0) return null
    return {
      from: bracketsFrom + 2,
      options: ranked.map(
        (target): Completion => ({
          label: target.name,
          type: 'text',
          apply: (view: EditorView, _completion, _from, to) => {
            const insert = linkMarkupFor(target, targets)
            view.dispatch({
              changes: { from: bracketsFrom, to, insert },
              selection: { anchor: bracketsFrom + insert.length },
              userEvent: 'input.complete',
            })
          },
        }),
      ),
      // A growing plain query keeps this result (the plugin narrows it);
      // a ] or | changes the grammar and re-asks the source.
      validFor: /^[^\][|]*$/,
    }
  }
}
