import { completionStatus, currentCompletions } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import { referenceSeams } from '@kamiazya/whiteboard-canvas-render'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { focusEditable } from '../../test-utils/focus-editable.js'
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

/** The option carrying this label, RIGHT NOW. Never stored. */
const optionLabelled = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll('.cm-tooltip-autocomplete li')].find((li) =>
    li.textContent?.includes(label),
  ) as HTMLElement | undefined

/**
 * Taps an option, re-resolving it at the moment of the gesture.
 *
 * The reference and the rect are both taken here rather than held from the
 * `waitFor` that established the option exists: the popup re-renders its
 * whole `<li>` list whenever the completion state updates, and
 * `wikiLinkTouchAccept` refuses a node the view no longer contains — so a
 * held reference makes the tap a no-op and the failure reads as "the option
 * did not commit", naming the feature rather than the stale node.
 *
 * `travel` moves the finger between touchstart and touchend, which is how
 * the scroll case says it is a scroll.
 */
function tap(label: string, identifier: number, travel = 0): void {
  const el = optionLabelled(label)
  if (el === undefined) throw new Error(`no completion option labelled ${label}`)
  const rect = el.getBoundingClientRect()
  const at = (type: 'touchstart' | 'touchend', y: number) =>
    new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      changedTouches: [new Touch({ identifier, target: el, clientX: rect.x + 4, clientY: y })],
    })
  el.dispatchEvent(at('touchstart', rect.y + 4))
  el.dispatchEvent(at('touchend', rect.y + 4 + travel))
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

    // acceptCompletion deliberately ignores an Enter within interactionDelay
    // (75ms) of the result opening — an accident guard a human never races.
    // The wait keeps this test on the human side of that guard; under load
    // it only grows, so the guard can never re-flake this.
    await new Promise((resolve) => setTimeout(resolve, 120))
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
    // The `:` shortcode source shares this one `autocompletion()` and
    // re-activates on EVERY keystroke even though its own trigger never
    // matches inside `[[` — CodeMirror marks the whole dialog `disabled`
    // (`cm-tooltip-autocomplete-disabled`, `currentCompletions` empty) for
    // as long as any source is pending, this sibling included. A tap that
    // lands in that window used to be silently dropped: `acceptCompletion`
    // refuses while disabled, same as it refuses while genuinely closed.
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
    const editable = getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]')
    const view = editable === null ? null : EditorView.findFromDOM(editable as HTMLElement)
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
