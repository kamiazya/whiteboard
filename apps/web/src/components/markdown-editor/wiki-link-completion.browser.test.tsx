import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { MarkdownEditor } from './MarkdownEditor.js'

// Real-keyboard regression for the [[ completion: CodeMirror's completion
// popup opens from real input events, and accepting with Enter routes
// through its keymap — neither is representable in jsdom.

afterEach(() => {
  cleanup()
  window.localStorage.removeItem('whiteboard.markdown-view-mode')
})

const TARGETS = [
  { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', name: 'Release plan' },
  { id: '01BX5ZZKBKACTAV9WEVGEMMVRZ', name: 'Retro notes' },
]

describe('wiki link completion (real browser)', () => {
  it('typing [[Re offers documents and Enter inserts the readable link', async () => {
    let value = ''
    const onChange = (next: string) => {
      value = next
    }
    const { getByTestId } = render(
      <MarkdownEditor initialViewMode="write" value="" onChange={onChange} linkTargets={TARGETS} />,
    )
    const editable = getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]')
    if (!editable) throw new Error('expected a contenteditable CodeMirror host')
    ;(editable as HTMLElement).focus()
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(editable)
    })

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
      expect(value).toBe('see [[Release plan]]')
    })
    // Accepting closed the popup rather than leaving it over the text.
    expect(document.querySelector('.cm-tooltip-autocomplete')).toBeNull()
  })

  it('plain prose never opens the popup', async () => {
    const { getByTestId } = render(
      <MarkdownEditor initialViewMode="write" value="" onChange={() => {}} linkTargets={TARGETS} />,
    )
    const editable = getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]')
    if (!editable) throw new Error('expected a contenteditable CodeMirror host')
    ;(editable as HTMLElement).focus()
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(editable)
    })
    await userEvent.keyboard('Release plan is due')
    // Give any (wrong) async popup a beat to appear before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(document.querySelector('.cm-tooltip-autocomplete')).toBeNull()
  })
})
