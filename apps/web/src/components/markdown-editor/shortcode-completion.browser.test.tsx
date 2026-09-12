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
import { shortcodeCompletionSource, shortcodeOptionRenderers } from './shortcode-completion.js'
import { wikiLinkCompletionTheme } from './wiki-link-completion.js'

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

/**
 * The popup UNDER THE APP'S OWN THEME, which the cases above deliberately do
 * not install — and the one thing that only shows there.
 *
 * The glyph is real DOM rather than a CSS `background-image` so it can take
 * `currentColor` and follow the row it sits on, including the selected one.
 * A background image is an isolated document and cannot see that colour.
 */
describe('the popup under the app theme', () => {
  it('draws the glyph on the row, where an emoji shows its character', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const themed = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: 'mark it ',
        extensions: [
          wikiLinkCompletionTheme,
          autocompletion({
            override: [shortcodeCompletionSource],
            addToOptions: shortcodeOptionRenderers,
            interactionDelay: 0,
          }),
        ],
      }),
    })
    try {
      themed.focus()
      themed.dispatch({ selection: { anchor: themed.state.doc.length } })
      type(themed, ':st')
      await vi.waitFor(() => expect(completionStatus(themed.state)).toBe('active'))
      const row = document.querySelector('[role="option"]') as HTMLElement
      expect(row.textContent).toContain('icon-star')
      const glyph = row.querySelector('.cm-completionIcon-wb-icon svg') as SVGSVGElement
      expect(glyph).not.toBeNull()
      // Inside the row, before the label — the emoji rows' character column.
      expect(row.firstElementChild?.nextElementSibling?.contains(glyph)).toBe(true)
      expect(glyph.getAttribute('stroke')).toBe('currentColor')
    } finally {
      themed.destroy()
      host.remove()
    }
  })
})
