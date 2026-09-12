/**
 * The `:name:` completion driven through a real CodeMirror view, which is
 * the half `shortcode-completion.test.ts` cannot reach: that one calls the
 * source directly, and what breaks here is the WIRING — a source that never
 * reaches the plugin's `override` array, or an Enter binding that outranks
 * the popup and puts a newline under a visible option list.
 *
 * Built on the same extension set the two hosts install rather than
 * mounting either of them, so the case says what it means: the popup opens,
 * Enter accepts, and the shortcode lands.
 */
import { acceptCompletion, autocompletion, completionStatus } from '@codemirror/autocomplete'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shortcodeCompletionSource } from './shortcode-completion.js'

let view: EditorView | undefined

afterEach(() => {
  view?.destroy()
  view = undefined
  document.body.replaceChildren()
})

function open(doc: string): EditorView {
  const host = document.createElement('div')
  document.body.append(host)
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        autocompletion({ override: [shortcodeCompletionSource], interactionDelay: 0 }),
        // Both hosts install this: while the popup is open Enter is
        // accept-or-nothing, never a newline under a visible list.
        Prec.highest(
          keymap.of([
            {
              key: 'Enter',
              run: (target) => {
                if (completionStatus(target.state) !== 'active') return false
                return acceptCompletion(target) || true
              },
            },
          ]),
        ),
      ],
    }),
  })
  view.focus()
  view.dispatch({ selection: { anchor: doc.length } })
  return view
}

/** Types one character the way the plugin sees a keystroke. */
function type(target: EditorView, text: string): void {
  const at = target.state.selection.main.head
  target.dispatch({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    userEvent: 'input.type',
  })
}

const popup = () => document.querySelector('.cm-tooltip-autocomplete')

describe('typing a name after a colon offers the emoji', () => {
  it('opens a list and accepting writes the shortcode', async () => {
    const target = open('ship it ')
    type(target, ':rocke')
    await vi.waitFor(() => {
      expect(popup()).not.toBeNull()
      expect(completionStatus(target.state)).toBe('active')
    })
    expect(popup()?.textContent).toContain('rocket')

    acceptCompletion(target)
    await vi.waitFor(() => {
      expect(target.state.doc.toString()).toBe('ship it :rocket:')
    })
  })

  /**
   * The wiring failure this exists for: an Enter that reaches the host's
   * own binding while a list is showing puts a newline in the body and
   * leaves the popup over it.
   */
  it('gives Enter to the list rather than to the line', async () => {
    const target = open('ship it ')
    type(target, ':rocke')
    await vi.waitFor(() => expect(completionStatus(target.state)).toBe('active'))

    const handled = target.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await vi.waitFor(() => {
      expect(target.state.doc.toString()).toBe('ship it :rocket:')
    })
    // Consumed, so nothing downstream sees it.
    expect(handled).toBe(false)
  })

  it('stays shut while a time is being typed', async () => {
    const target = open('meet at 10')
    type(target, ':30')
    await vi.waitFor(() => expect(target.state.doc.toString()).toBe('meet at 10:30'))
    expect(popup()).toBeNull()
  })
})

/**
 * The icon half, through the same real view — and the half that CANNOT be
 * checked by calling the source.
 *
 * Measured: with the rows ordered by `boost` the source returned the icon
 * FIRST and the popup did not show it at all, because CodeMirror scores an
 * option as `match.score + boost` and charges -700 for a pattern matching
 * anywhere but the label's start. A unit test on the source's array was
 * green over a list a person could not see the row in.
 */
describe('an icon offered under the same colon', () => {
  it('is shown, first, under its own heading', async () => {
    const target = open('mark it ')
    type(target, ':st')
    await vi.waitFor(() => expect(completionStatus(target.state)).toBe('active'))
    const labels = [...document.querySelectorAll('.cm-completionLabel')].map((n) => n.textContent)
    expect(labels[0]).toBe('icon-star')
    expect(popup()?.textContent).toContain('Icons')
    // The emoji are still there, under their own heading. Asserted by
    // COUNT rather than by naming one: a row renders its `displayLabel`,
    // which for an emoji is the character plus the name, so naming `star`
    // was an assertion about CLDR spelling rather than about the list.
    expect(popup()?.textContent).toContain('Emoji')
    expect(labels.filter((l) => !l?.startsWith('icon-')).length).toBeGreaterThan(1)
  })

  it('keeps the list open once the hyphen is typed', async () => {
    const target = open('mark it ')
    type(target, ':icon')
    await vi.waitFor(() => expect(completionStatus(target.state)).toBe('active'))
    type(target, '-')
    await vi.waitFor(() => {
      expect(completionStatus(target.state)).toBe('active')
      expect(popup()?.textContent).toContain('icon-star')
    })
  })

  it('accepting writes the shortcode the renderer resolves', async () => {
    const target = open('mark it ')
    type(target, ':icon-st')
    await vi.waitFor(() => expect(completionStatus(target.state)).toBe('active'))
    acceptCompletion(target)
    await vi.waitFor(() => expect(target.state.doc.toString()).toBe('mark it :icon-star:'))
  })
})
