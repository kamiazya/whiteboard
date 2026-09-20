import { completionStatus, currentCompletions } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import { referenceSeams } from '@kamiazya/whiteboard-canvas-render'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { tapElement } from '../../test-utils/tap.js'
import { MarkdownEditor } from './MarkdownEditor.js'

// Real-keyboard regression for the [[ completion: CodeMirror's completion
// popup opens from real input events, and accepting with Enter routes
// through its keymap — neither is representable in jsdom.

afterEach(() => {
  cleanup()
  window.localStorage.removeItem('whiteboard.markdown-view-mode')
})

const TARGETS = [
  { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', path: 'release-plan', name: 'Release plan' },
  { id: '01BX5ZZKBKACTAV9WEVGEMMVRZ', path: 'retro-notes', name: 'Retro notes' },
]

/** Two distinct documents that happen to share a display name. */
const SAME_NAME_TARGETS = [
  { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', path: 'retro-notes-a', name: 'Retro notes' },
  { id: '01BX5ZZKBKACTAV9WEVGEMMVRZ', path: 'retro-notes-b', name: 'Retro notes' },
]

/** The option carrying this label, RIGHT NOW. Never stored. */
const optionLabelled = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll('.cm-tooltip-autocomplete li')].find((li) =>
    li.textContent?.includes(label),
  ) as HTMLElement | undefined

/** Every option currently labelled exactly `label`, in list order. */
const optionsLabelled = (label: string): HTMLElement[] =>
  [...document.querySelectorAll('.cm-tooltip-autocomplete li')].filter(
    (li) => li.querySelector('.cm-completionLabel')?.textContent === label,
  ) as HTMLElement[]

/**
 * Taps an option, re-resolving it at the moment of the gesture.
 *
 * The reference and the rect are both taken here rather than held from the
 * `waitFor` that established the option exists: the popup re-renders its
 * whole `<li>` list whenever the completion state updates, and
 * `wikiLinkTouchAccept` refuses a node the view no longer contains — so a
 * held reference makes the tap a no-op and the failure reads as "the option
 * did not commit", naming the feature rather than the stale node.
 */
function tap(label: string, identifier: number, travel = 0): void {
  const el = optionLabelled(label)
  if (el === undefined) throw new Error(`no completion option labelled ${label}`)
  tapElement(el, identifier, travel)
}

describe('wiki link completion (real browser)', () => {
  it('typing [[Re offers documents and Enter inserts the readable link', async () => {
    let value = ''
    const onChange = (next: string) => {
      value = next
    }
    const { getByTestId } = render(
      <MarkdownEditor initialViewMode="write" value="" onChange={onChange} linkTargets={TARGETS} />,
    )
    await focusEditable(() =>
      getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]'),
    )

    // user-event treats [[ as an escaped literal [ — four brackets type two.
    await userEvent.keyboard('see [[[[Re')
    // The completion tooltip lists both matches, best first.
    // Selection, not mere presence: the tooltip keeps rendering through a
    // re-query, but only an ACTIVE result marks an option selected — and
    // only then does Enter accept instead of inserting a newline. This is
    // what the user sees before pressing Enter, so it is what the test
    // waits for.
    await vi.waitFor(() => {
      const selected = document.querySelector('.cm-tooltip-autocomplete li[aria-selected="true"]')
      expect(selected?.textContent).toContain('Release plan')
    })

    // No wait between the selection and the Enter. This editor sets
    // `interactionDelay: 0` deliberately (MarkdownEditor.tsx says why), so
    // upstream's accept-too-soon guard never fires here — and the wait above
    // has already established the only precondition Enter needs, since an
    // option is marked selected exactly when a result is ACTIVE.
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() => {
      expect(value).toBe('see [[release-plan]]')
    })
    // Accepting closed the popup rather than leaving it over the text.
    expect(document.querySelector('.cm-tooltip-autocomplete')).toBeNull()
  })

  it('tapping an option accepts it — the touch path, not only Enter', async () => {
    let value = ''
    const { getByTestId } = render(
      <MarkdownEditor
        initialViewMode="write"
        value=""
        onChange={(next) => {
          value = next
        }}
        linkTargets={TARGETS}
      />,
    )
    await focusEditable(() =>
      getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]'),
    )
    await userEvent.keyboard('see [[[[Ret')
    const option = await vi.waitFor(() => {
      const el = [...document.querySelectorAll('.cm-tooltip-autocomplete li')].find((li) =>
        li.textContent?.includes('Retro notes'),
      )
      expect(el).toBeDefined()
      return el as HTMLElement
    })
    await userEvent.click(option)
    await vi.waitFor(() => {
      expect(value).toBe('see [[retro-notes]]')
    })
  })

  it('the preview catches up with an accepted completion once the debounce settles', async () => {
    // The dogfood report: on a phone, accepting a completion left the
    // preview disagreeing with the source. The controlled round-trip is
    // value -> onChange -> value -> debounced preview; this pins that an
    // accept (a programmatic dispatch, not typing) travels the whole way.
    function Harness() {
      const [value, setValue] = useState('')
      return (
        <MarkdownEditor
          initialViewMode="split"
          previewDebounceMs={30}
          value={value}
          onChange={setValue}
          linkTargets={TARGETS}
          // The inserted markup is the bare [[path]]; what the preview
          // SHOWS is the render-time title, so the round-trip is only
          // complete when both seams are wired the way a page wires them.
          references={referenceSeams(new Map(), {
            resolveAlias: (alias) => TARGETS.find((t) => t.path === alias)?.id ?? null,
            resolveTitle: (documentId) => TARGETS.find((t) => t.id === documentId)?.name,
          })}
        />
      )
    }
    const { getByTestId } = render(<Harness />)
    await focusEditable(() =>
      getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]'),
    )
    await userEvent.keyboard('see [[[[Re')
    await vi.waitFor(() => {
      expect(
        document.querySelector('.cm-tooltip-autocomplete li[aria-selected="true"]'),
      ).toBeTruthy()
    })
    await new Promise((resolve) => setTimeout(resolve, 120))
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() => {
      const preview = getByTestId('markdown-preview-pane')
      expect(preview.textContent).toContain('Release plan')
    })
  })

  it('a real touch tap on an option commits it — no synthesized mouse events required', async () => {
    // The phone report: an option looks selected but nothing commits.
    // Upstream accepts on the synthesized mousedown and closes on the
    // contenteditable blur + 10ms — an ordering a touch can lose, and one a
    // synthetic TouchEvent (which synthesizes no mouse events at all)
    // reproduces deterministically.
    let value = ''
    const { getByTestId } = render(
      <MarkdownEditor
        initialViewMode="write"
        value=""
        onChange={(next) => {
          value = next
        }}
        linkTargets={TARGETS}
      />,
    )
    await focusEditable(() =>
      getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]'),
    )
    await userEvent.keyboard('see [[[[Ret')
    await vi.waitFor(() => expect(optionLabelled('Retro notes')).toBeDefined())
    tap('Retro notes', 1)
    await vi.waitFor(() => {
      expect(value).toBe('see [[retro-notes]]')
    })

    // And a scroll gesture over the list must NOT commit: same events, but
    // the finger travelled.
    await userEvent.keyboard(' and [[[[Rel')
    await vi.waitFor(() => expect(optionLabelled('Release plan')).toBeDefined())
    tap('Release plan', 2, 56)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(value).toBe('see [[retro-notes]] and [[Rel')
  })

  it('a tap while a sibling source refreshes the list is committed once the list is back', async () => {
    // The disabled window is the `:` sibling source re-activating on every
    // keystroke — see `deferred` in `wikiLinkTouchAccept`. A tap landing in
    // it used to be silently dropped: `acceptCompletion` refuses while
    // disabled, same as it refuses while genuinely closed.
    let value = ''
    const { getByTestId } = render(
      <MarkdownEditor
        initialViewMode="write"
        value=""
        onChange={(next) => {
          value = next
        }}
        linkTargets={TARGETS}
      />,
    )
    await focusEditable(() =>
      getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]'),
    )
    // focusEditable just proved the editable exists and holds focus.
    const view = EditorView.findFromDOM(document.activeElement as HTMLElement)
    if (view === null) throw new Error('the source pane is not a mounted CodeMirror view')

    await userEvent.keyboard('see [[[[Re')
    await vi.waitFor(() => {
      expect(currentCompletions(view.state).length).toBeGreaterThan(0)
    })

    // One synchronous task: no timer can run between this keystroke and the
    // tap that follows it, so the disabled window is a CONDITION rather than
    // a race the test has to get lucky on.
    const head = view.state.doc.length
    view.dispatch({
      changes: { from: head, insert: 't' },
      selection: { anchor: head + 1 },
      userEvent: 'input.type',
    })

    // Premise: the keystroke put the dialog in the exact disabled state a
    // real fast typist produces after every character — never asserted by
    // waiting, so a premise that stops holding fails loudly instead of the
    // test quietly racing past it.
    expect(
      document
        .querySelector('.cm-tooltip-autocomplete')
        ?.classList.contains('cm-tooltip-autocomplete-disabled'),
    ).toBe(true)
    expect(currentCompletions(view.state)).toHaveLength(0)
    expect(completionStatus(view.state)).toBe('pending')
    expect(optionLabelled('Retro notes')).toBeDefined()

    tap('Retro notes', 3)
    await vi.waitFor(() => {
      expect(value).toBe('see [[retro-notes]]')
    })
  })

  it('a deferred tap on the SECOND of two same-named options links the one actually tapped', async () => {
    // Two documents named "Retro notes": the deferred-tap commit resolves
    // the tapped option by label once the list re-enables, and a label
    // alone cannot tell them apart. Tapping the second occurrence must not
    // silently link the first.
    let value = ''
    const { getByTestId } = render(
      <MarkdownEditor
        initialViewMode="write"
        value=""
        onChange={(next) => {
          value = next
        }}
        linkTargets={SAME_NAME_TARGETS}
      />,
    )
    await focusEditable(() =>
      getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]'),
    )
    const view = EditorView.findFromDOM(document.activeElement as HTMLElement)
    if (view === null) throw new Error('the source pane is not a mounted CodeMirror view')

    await userEvent.keyboard('see [[[[Re')
    await vi.waitFor(() => {
      expect(optionsLabelled('Retro notes')).toHaveLength(2)
    })

    // Same disabled-window trigger as the sibling-refresh test above: one
    // synchronous keystroke, so the tap below deterministically lands while
    // the dialog is disabled rather than racing a timer for it.
    const head = view.state.doc.length
    view.dispatch({
      changes: { from: head, insert: 't' },
      selection: { anchor: head + 1 },
      userEvent: 'input.type',
    })
    expect(completionStatus(view.state)).toBe('pending')
    expect(currentCompletions(view.state)).toHaveLength(0)
    const [first, second] = optionsLabelled('Retro notes')
    if (first === undefined || second === undefined) throw new Error('expected two options')

    tapElement(second, 4)
    await vi.waitFor(() => {
      expect(value).toBe('see [[retro-notes-b]]')
    })
  })

  it('a deferred tap given up on (the label re-render dropped) commits nothing', async () => {
    // The query changes between the tap and the list re-enabling — the
    // refreshed list no longer contains an option labelled "Retro notes" at
    // all, so the commit must give up rather than link something the user
    // never selected. "l" is the disabling keystroke rather than "t": it
    // is in "Release plan" and not in "Retro notes" at all, so the settled
    // list is deterministic rather than resting on how fuzzily an unrelated
    // matcher scores a typo.
    let value = ''
    const { getByTestId } = render(
      <MarkdownEditor
        initialViewMode="write"
        value=""
        onChange={(next) => {
          value = next
        }}
        linkTargets={TARGETS}
      />,
    )
    await focusEditable(() =>
      getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]'),
    )
    const view = EditorView.findFromDOM(document.activeElement as HTMLElement)
    if (view === null) throw new Error('the source pane is not a mounted CodeMirror view')

    await userEvent.keyboard('see [[[[Re')
    await vi.waitFor(() => expect(optionLabelled('Retro notes')).toBeDefined())

    // Disable the dialog (as above), then tap the now-frozen "Retro notes"
    // option while it is unresponsive.
    const disableHead = view.state.doc.length
    view.dispatch({
      changes: { from: disableHead, insert: 'l' },
      selection: { anchor: disableHead + 1 },
      userEvent: 'input.type',
    })
    expect(completionStatus(view.state)).toBe('pending')
    expect(currentCompletions(view.state)).toHaveLength(0)
    tap('Retro notes', 5)

    // The dialog re-enables against the now-narrowed "Rel" query: "Release
    // plan" survives, "Retro notes" — the option actually tapped — does not.
    await vi.waitFor(() => {
      const selected = document.querySelector('.cm-tooltip-autocomplete li[aria-selected="true"]')
      expect(selected?.textContent).toContain('Release plan')
    })
    expect(optionLabelled('Retro notes')).toBeUndefined()

    // The deferred commit, if it fired, was queued as a microtask by the
    // update that re-enabled the list; `vi.waitFor` polls on a macrotask, so
    // by the time it resolved that microtask had already run. Nothing was
    // committed — neither the vanished "Retro notes" option nor an accidental
    // commit of whatever is now selected. The document is exactly what was typed.
    expect(value).toBe('see [[Rel')
  })

  it('a real close (query leaves the [[ grammar) clears a deferred tap for good', async () => {
    // Closing the popup for real — not merely the sibling source's disabled
    // window — must drop the deferred tap so a LATER list that happens to
    // reuse the same label is never auto-committed against.
    let value = ''
    const { getByTestId } = render(
      <MarkdownEditor
        initialViewMode="write"
        value=""
        onChange={(next) => {
          value = next
        }}
        linkTargets={TARGETS}
      />,
    )
    await focusEditable(() =>
      getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]'),
    )
    const view = EditorView.findFromDOM(document.activeElement as HTMLElement)
    if (view === null) throw new Error('the source pane is not a mounted CodeMirror view')

    await userEvent.keyboard('a[[[[Ret')
    await vi.waitFor(() => expect(optionLabelled('Retro notes')).toBeDefined())

    const disableHead = view.state.doc.length
    view.dispatch({
      changes: { from: disableHead, insert: 't' },
      selection: { anchor: disableHead + 1 },
      userEvent: 'input.type',
    })
    expect(completionStatus(view.state)).toBe('pending')
    tap('Retro notes', 6)

    // `]` leaves the `[[query` grammar the source matches on, so the next
    // re-evaluation closes the popup for real rather than merely refreshing.
    const closeHead = view.state.doc.length
    view.dispatch({
      changes: { from: closeHead, insert: ']' },
      selection: { anchor: closeHead + 1 },
      userEvent: 'input.type',
    })
    await vi.waitFor(() => {
      expect(completionStatus(view.state)).toBeNull()
      expect(document.querySelector('.cm-tooltip-autocomplete')).toBeNull()
    })

    // Reopen a fresh list that happens to offer the same label again.
    await userEvent.keyboard(' [[[[Ret')
    await vi.waitFor(() => expect(optionLabelled('Retro notes')).toBeDefined())

    // No stale commit landed: the document is exactly what was typed, with
    // no injected [[retro-notes]] markup from the tap that was given up on.
    expect(value).toBe('a[[Rett] [[Ret')
  })

  it('plain prose never opens the popup', async () => {
    const { getByTestId } = render(
      <MarkdownEditor initialViewMode="write" value="" onChange={() => {}} linkTargets={TARGETS} />,
    )
    await focusEditable(() =>
      getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]'),
    )
    await userEvent.keyboard('Release plan is due')
    // Give any (wrong) async popup a beat to appear before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(document.querySelector('.cm-tooltip-autocomplete')).toBeNull()
  })
})
