/**
 * A real pointer press on a proposal's gutter marker, in a real browser.
 *
 * jsdom can show that the marker's `mousedown` is cancelled, but not what
 * cancelling it is for: without it the button takes focus from the editor,
 * so the reader is thrown out of the text to open a card about it. Only a
 * browser has a focus model to lose. The caret is asserted beside it because
 * the press must not move that either, though in this mount it stays put
 * even when the press is not cancelled.
 */
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { Proposal } from '@kamiazya/whiteboard-model'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { proposalDecorations, setProposalProjection } from './proposal-decorations.js'

const BODY = 'Ship on Thursday.\nSecond line.\nThird line, where the caret sits.'

const PROPOSALS: Proposal[] = [
  {
    id: 'p1',
    changes: [
      {
        id: 'c1',
        op: 'body.replace',
        status: 'open',
        anchor: { kind: 'text', quote: { exact: 'Thursday' }, start: 8, end: 16 },
        text: 'Friday',
        assumed: 'Thursday',
      },
    ],
  },
]

let view: EditorView | undefined

afterEach(() => {
  view?.destroy()
  view = undefined
  document.body.replaceChildren()
})

it('keeps focus in the editor and the caret in place when the marker is pressed', async () => {
  const onSelectPassage = vi.fn()
  const host = document.createElement('div')
  document.body.append(host)
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: BODY,
      extensions: [proposalDecorations({ onSelectPassage })],
    }),
  })
  view.dispatch({
    selection: { anchor: BODY.length },
    effects: setProposalProjection.of({ proposals: PROPOSALS, selectedChangeId: null }),
  })
  view.focus()
  const target = view

  const marker = await vi.waitFor(() => {
    const found = target.dom.querySelector<HTMLElement>('.cm-proposal-gutter-marker')
    expect(found).not.toBeNull()
    return found as HTMLElement
  })
  await userEvent.click(marker)

  // The press still reaches the host: the activation is the `click`.
  expect(onSelectPassage).toHaveBeenCalledWith('p1', 'c1', expect.any(Object))
  expect(target.state.selection.main.head).toBe(BODY.length)
  expect(target.hasFocus).toBe(true)
})
