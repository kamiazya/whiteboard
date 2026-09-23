/**
 * The completion popup BOTH sources share: the chrome it is drawn in and
 * the deterministic tap that commits an option.
 *
 * Its own module because neither belongs to a source. The editors install
 * one `autocompletion()` carrying the `[[` document source and the `:`
 * shortcode source together, and what is here applies to whichever of them
 * drew the row under the finger. It lived in `wiki-link-completion.ts` for
 * no better reason than that the `[[` source was written first, and the
 * name misled twice: a shortcode test imports the theme from a module named
 * for wiki links, and a node editor was read as lacking `[[` completion
 * when what it lacked was the tap.
 */

import {
  acceptCompletion,
  completionStatus,
  currentCompletions,
  setSelectedCompletion,
} from '@codemirror/autocomplete'
import { Prec } from '@codemirror/state'
import type { Command } from '@codemirror/view'
import { EditorView, keymap, ViewPlugin } from '@codemirror/view'

/**
 * Where the `occurrence`-th option carrying `label` sits, or -1.
 *
 * By OCCURRENCE rather than by label alone because a refresh can reorder the
 * list and two sources can offer the same text: the tap recorded which of
 * the identically-labelled rows was under the finger, and accepting a
 * different one would insert something the person never saw highlighted.
 */
function indexOfOccurrence(
  options: readonly { label: string }[],
  label: string,
  occurrence: number,
): number {
  let seen = 0
  for (let i = 0; i < options.length; i++) {
    if (options[i]?.label !== label) continue
    seen += 1
    if (seen === occurrence) return i
  }
  return -1
}

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

export const completionTouchAccept = ViewPlugin.define((view) => {
  let startY: number | null = null
  /**
   * A tap whose `acceptCompletion` refused. The dialog shares one
   * `autocompletion()` with the `:` shortcode source, which re-activates on
   * EVERY keystroke — even inside `[[`, where its own trigger never matches
   * — and CodeMirror disables the whole dialog for as long as any source is
   * pending, this sibling included (`cm-tooltip-autocomplete-disabled`,
   * `currentCompletions` empty). A tap landing in that window is a real,
   * visible option; `update()` below commits it once the dialog re-enables.
   *
   * Matched by LABEL plus OCCURRENCE, not label alone: the refreshed list is
   * a fresh render with new indices, but two documents can share a display
   * name, and matching the first same-labelled option would link whichever
   * one now sorts first rather than the one actually tapped. Occurrence
   * survives the refresh because `getTargets()`'s order does not change
   * between keystrokes and `rankLinkTargets` keeps ties in that order, so
   * two same-labelled options keep the same relative position.
   */
  interface DeferredTap {
    readonly label: string
    readonly occurrence: number
  }
  let deferred: DeferredTap | null = null
  const optionAt = (target: EventTarget | null): HTMLElement | null => {
    const li = target instanceof Element ? target.closest('.cm-tooltip-autocomplete li') : null
    return li instanceof HTMLElement && view.dom.contains(li) ? li : null
  }
  const onTouchStart = (event: TouchEvent) => {
    startY = optionAt(event.target) === null ? null : (event.changedTouches[0]?.clientY ?? null)
  }
  /**
   * Commit what this rendered `<li>` stands for, whatever the dialog's own
   * state says. Answers whether the key or the tap was CONSUMED, so a
   * caller that must decide between accepting and its own verb can ask.
   *
   * Taken from the DOM rather than from `currentCompletions(view.state)`,
   * which is empty the whole time the dialog is disabled — the list the
   * user is looking at is the only thing that still knows which option
   * this is.
   */
  const acceptRendered = (li: HTMLElement): boolean => {
    const match = /-(\d+)$/.exec(li.id)
    if (match === null) return false
    const label = li.querySelector('.cm-completionLabel')?.textContent ?? null
    view.dispatch({ effects: setSelectedCompletion(Number(match[1])) })
    if (acceptCompletion(view)) return true
    if (label === null) return false
    const siblings = li.parentElement === null ? [li] : [...li.parentElement.children]
    const occurrence = siblings
      .slice(0, siblings.indexOf(li) + 1)
      .filter(
        (sibling) => sibling.querySelector('.cm-completionLabel')?.textContent === label,
      ).length
    deferred = { label, occurrence }
    return true
  }
  const onTouchEnd = (event: TouchEvent) => {
    const li = optionAt(event.target)
    const endY = event.changedTouches[0]?.clientY
    if (li === null || startY === null || endY === undefined) return
    if (Math.abs(endY - startY) > TAP_SLOP_PX) return
    // No synthesized mouse events after a tap this plugin took: upstream
    // must not accept a second time, and the blur that would close the
    // popup never fires. A tap it did NOT take is left to upstream, which
    // is what happened before this plugin existed.
    if (acceptRendered(li)) event.preventDefault()
  }
  view.dom.addEventListener('touchstart', onTouchStart, { passive: true })
  view.dom.addEventListener('touchend', onTouchEnd, { passive: false })
  return {
    acceptRendered,
    update() {
      if (deferred === null) return
      const options = currentCompletions(view.state)
      if (options.length === 0) {
        // Still refreshing (or the dialog closed under the tap) — only give
        // up once the source has genuinely gone quiet.
        if (completionStatus(view.state) === null) deferred = null
        return
      }
      const { label, occurrence } = deferred
      deferred = null
      const index = indexOfOccurrence(options, label, occurrence)
      if (index === -1) return
      // A ViewPlugin's own update() cannot dispatch synchronously; queue for
      // right after CodeMirror finishes applying this one.
      queueMicrotask(() => {
        view.dispatch({ effects: setSelectedCompletion(index) })
        acceptCompletion(view)
      })
    },
    destroy() {
      view.dom.removeEventListener('touchstart', onTouchStart)
      view.dom.removeEventListener('touchend', onTouchEnd)
    },
  }
})

/**
 * Accept the option the popup is DRAWING, even while the dialog is
 * disabled. Answers false when nothing is drawn, so a caller falls through
 * to its own verb.
 *
 * It exists because `completionStatus` cannot tell the two `pending` cases
 * apart. Every keystroke re-activates BOTH sources of the one shared
 * `autocompletion()`, so for about `activateOnTypingDelay` after each
 * character the dialog is disabled while its popup stays on screen — and
 * for plain prose, which will never produce a popup at all, the sources
 * are pending in exactly the same way. Enter must take the key in the
 * first case and leave it in the second, and the rendered list is the only
 * thing that separates them: `currentCompletions` is empty for both.
 *
 * `aria-selected` is what the person is looking at, so it is what commits;
 * a dialog CodeMirror has not marked falls back to the first row, which is
 * what `selectOnOpen` would have marked.
 */
export const acceptRenderedCompletion: Command = (view) => {
  const list = view.dom.querySelector('.cm-tooltip-autocomplete ul')
  if (list === null) return false
  const li = list.querySelector('li[aria-selected="true"]') ?? list.querySelector('li')
  if (!(li instanceof HTMLElement)) return false
  return view.plugin(completionTouchAccept)?.acceptRendered(li) ?? false
}

/**
 * Enter, for a host whose other claim on the key is the markdown keymap.
 *
 * While the popup is OPEN ('active') Enter is accept-or-nothing — never a
 * newline under a visible option list. 'pending' must fall through, or
 * Enter after typing "- item" would eat the list continuation; but a list
 * that is DRAWN is pending too, and that one owns the key. Which of the
 * two a 'pending' is, only `acceptRenderedCompletion` can say.
 *
 * `Prec.highest` because `autocompletion()` installs its own keymap there
 * as well, and within that precedence whichever is listed first wins.
 */
export const completionEnterKeymap = Prec.highest(
  keymap.of([
    {
      key: 'Enter',
      run: (view) => {
        const status = completionStatus(view.state)
        if (status === 'active') return acceptCompletion(view) || true
        return status !== null && acceptRenderedCompletion(view)
      },
    },
  ]),
)

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
 * The popup's chrome, for EVERY completion source the editors install — the
 * `[[` one this module owns and the `:` one beside it. It lives here because
 * that is where the first source was; a reader looking for why a shortcode
 * row is styled the way it is has to come to this file.
 */
export const completionPopupTheme = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md)',
    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    overflow: 'hidden',
  },
  // The heading a sectioned list draws. A custom element rather than a class
  // — `.cm-completionSection` matches nothing — and unstyled it renders at
  // the label's own size and colour, so a heading reads as loud as the rows
  // it is grouping.
  '.cm-tooltip.cm-tooltip-autocomplete completion-section': {
    display: 'block',
    padding: '0.375rem 0.5rem 0.125rem',
    fontSize: '0.75rem',
    fontWeight: '500',
    color: 'var(--muted-foreground)',
  },
  // Says what KIND of thing a row is, so it must not compete with what the
  // row is called.
  '.cm-tooltip.cm-tooltip-autocomplete .cm-completionDetail': {
    color: 'var(--muted-foreground)',
    fontStyle: 'normal',
    fontSize: '0.75rem',
    marginLeft: '0.5rem',
  },
  // A drawn glyph in the row's gutter, sitting where an emoji row's
  // character does. `inline-flex` so it shares the label's baseline box
  // rather than the line box, which left it riding high.
  '.cm-tooltip.cm-tooltip-autocomplete .cm-completionIcon-wb-icon': {
    display: 'inline-flex',
    alignItems: 'center',
    verticalAlign: 'text-bottom',
    marginRight: '0.375rem',
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
