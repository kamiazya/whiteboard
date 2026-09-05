import {
  acceptCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  setSelectedCompletion,
} from '@codemirror/autocomplete'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { type LinkTarget, linkMarkupFor, rankLinkTargets } from '../../lib/link-target.js'

/**
 * The popup in the app's popover clothes. An EditorView.theme rather than
 * index.css on purpose: the app stylesheet lives inside CSS @layer blocks,
 * and CodeMirror injects its own UNLAYERED style element at view creation —
 * which beats any layered rule regardless of specificity, so an index.css
 * override silently loses. A theme extension compiles to CodeMirror's own
 * generated classes and wins by the same mechanism the defaults do. CSS
 * custom properties resolve at runtime, so the popover tokens (and theme
 * switches) keep covering this surface.
 */
/**
 * Deterministic tap-commit for the completion popup. Upstream accepts on
 * the SYNTHESIZED mousedown and separately closes the popup when the
 * contenteditable blurs (with a 10ms grace) — on touch devices the tap
 * that should accept is also the tap that blurs the editor, and whether
 * the synthesized mousedown beats the blur is a per-platform ordering the
 * user experienced losing: the option highlights, nothing commits.
 * touchend precedes both, so accepting there removes the race; a moved
 * finger (a scroll over the option list) stays a scroll.
 */
const TAP_SLOP_PX = 12

export const wikiLinkTouchAccept = ViewPlugin.define((view) => {
  let startY: number | null = null
  const optionAt = (target: EventTarget | null): HTMLElement | null => {
    const li = target instanceof Element ? target.closest('.cm-tooltip-autocomplete li') : null
    return li instanceof HTMLElement && view.dom.contains(li) ? li : null
  }
  const onTouchStart = (event: TouchEvent) => {
    startY = optionAt(event.target) === null ? null : (event.changedTouches[0]?.clientY ?? null)
  }
  const onTouchEnd = (event: TouchEvent) => {
    const li = optionAt(event.target)
    const endY = event.changedTouches[0]?.clientY
    if (li === null || startY === null || endY === undefined) return
    if (Math.abs(endY - startY) > TAP_SLOP_PX) return
    const match = /-(\d+)$/.exec(li.id)
    if (match === null) return
    // No synthesized mouse events after this tap: upstream must not accept
    // a second time, and the blur that would close the popup never fires.
    event.preventDefault()
    view.dispatch({ effects: setSelectedCompletion(Number(match[1])) })
    acceptCompletion(view)
  }
  view.dom.addEventListener('touchstart', onTouchStart, { passive: true })
  view.dom.addEventListener('touchend', onTouchEnd, { passive: false })
  return {
    destroy() {
      view.dom.removeEventListener('touchstart', onTouchStart)
      view.dom.removeEventListener('touchend', onTouchEnd)
    },
  }
})

export const wikiLinkCompletionTheme = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'inherit',
    fontSize: '0.875rem',
    maxHeight: '16rem',
    padding: '0.25rem',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    borderRadius: 'var(--radius-sm)',
    padding: '0.25rem 0.5rem',
    lineHeight: '1.4',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent)',
    color: 'var(--accent-foreground)',
  },
  // The generic "text" kind icon says nothing a document list needs said,
  // and eats a monospace-width gutter.
  '.cm-tooltip.cm-tooltip-autocomplete .cm-completionIcon': {
    display: 'none',
  },
})

/**
 * `[[` completion for document references. Accepting a candidate writes the
 * same markup the Link picker would (`linkMarkupFor`) — the bare
 * `[[path]]`, labeled with the target's display name at render time — so
 * the two entry points cannot teach different link spellings.
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
    // the same rule the codec scanner enforces on read. A `#` ends the
    // document half of the address: what follows names a heading or a group
    // inside it, which this list does not know, and a popup that stayed open
    // would swallow the Enter meant to finish the line.
    const match = context.matchBefore(/\[\[[^\][|#]*$/)
    if (match === null) return null
    const targets = getTargets()
    if (targets.length === 0) return null
    const ranked = rankLinkTargets(targets, match.text.slice(2))
    if (ranked.length === 0) return null
    return {
      from: match.from + 2,
      options: ranked.map(
        (target): Completion => ({
          label: target.name,
          type: 'text',
          apply: (view: EditorView, _completion, from, to) => {
            // The brackets sit two characters before the QUERY start — and
            // it must be the `from` the plugin passes, never a position
            // captured when the source ran: the document may have changed in
            // between (mobile autocorrect elsewhere, a CRDT remote echo,
            // another tab), and the plugin maps from/to through those
            // changes while a captured offset stays behind and writes the
            // markup mid-word, corrupting the body.
            const bracketsFrom = from - 2
            if (view.state.sliceDoc(bracketsFrom, from) !== '[[') return
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
