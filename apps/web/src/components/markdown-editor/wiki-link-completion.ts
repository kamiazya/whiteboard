import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { type LinkTarget, linkMarkupFor, rankLinkTargets } from './link-target.js'

/**
 * `[[` completion for document references. The list is the same ranking the
 * Link verb's picker shows (`rankLinkTargets`), and accepting a candidate
 * writes the same markup the picker would (`linkMarkupFor`) — readable
 * `[[Name]]` when unique, `[[<id>|Name]]` otherwise — so the two entry
 * points cannot teach different link spellings.
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
    const ranked = rankLinkTargets(targets, match.text.slice(2))
    if (ranked.length === 0) return null
    return {
      from: match.from,
      options: ranked.map((target) => ({
        label: target.name,
        type: 'text',
        apply: linkMarkupFor(target, targets),
      })),
      // OUR ranking is the ranking (the picker's, so both entry points
      // agree). filter:false is load-bearing, not an optimisation: the
      // plugin's default filter re-matches label against the text from
      // `from` — which starts at `[[`, a string no document name contains —
      // so every option scores zero and the result is silently discarded.
      // Without validFor the source re-runs per keystroke; targets are a
      // workspace's document list, so that is cheap.
      filter: false,
    }
  }
}
