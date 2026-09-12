/**
 * The `:name:` completion driven through a real CodeMirror view, which is
 * the half `emoji-completion.test.ts` cannot reach: that one calls the
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
import { emojiCompletionSource } from './emoji-completion.js'

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
        autocompletion({ override: [emojiCompletionSource], interactionDelay: 0 }),
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
