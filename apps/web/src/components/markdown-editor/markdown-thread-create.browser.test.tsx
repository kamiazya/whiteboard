/**
 * Opening a conversation from the body, in a real browser.
 *
 * The gesture is a SELECTION plus a catalog row, and neither half is
 * observable outside a real editor: a CodeMirror selection is state inside a
 * live view, and what the row must hand its host is an anchor derived from
 * that selection's offsets — not the offsets themselves, which the next
 * edit invalidates.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const BODY = 'Ship the report on Friday.'

async function selectFromStart(container: HTMLElement, right: number, extend: number) {
  await focusEditable(
    () =>
      container
        .querySelector('[data-testid="markdown-source-pane"]')
        ?.querySelector('[contenteditable="true"]') ?? null,
  )
  await userEvent.keyboard('{Control>}{Home}{/Control}')
  for (let i = 0; i < right; i++) await userEvent.keyboard('{ArrowRight}')
  for (let i = 0; i < extend; i++) await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}')
}

describe('opening a thread from the body', () => {
  it('hands the host an anchor quoting the selection, with its surroundings', async () => {
    const onComposeThread = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor
        initialViewMode="write"
        value={BODY}
        onChange={vi.fn()}
        onComposeThread={onComposeThread}
      />,
    )
    await selectFromStart(container, 9, 6) // "report"

    await userEvent.click(getByRole('button', { name: 'Editing actions' }))
    await userEvent.click(getByRole('menuitem', { name: 'Comment on this' }))

    // The quote and its context, not the offsets alone: `resolveTextAnchor`
    // falls back to them when the body has moved, and an anchor carrying no
    // context re-finds a repeated passage by distance, which is wrong as
    // often as it is right.
    expect(onComposeThread).toHaveBeenCalledWith({
      kind: 'text',
      quote: { prefix: 'Ship the ', exact: 'report', suffix: ' on Friday.' },
      start: 9,
      end: 15,
    })
  })

  it("quotes the caret's whole block with nothing selected, rather than guessing at a word", async () => {
    const onComposeThread = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor
        initialViewMode="write"
        value={BODY}
        onChange={vi.fn()}
        onComposeThread={onComposeThread}
      />,
    )
    await selectFromStart(container, 9, 0)

    await userEvent.click(getByRole('button', { name: 'Editing actions' }))
    await userEvent.click(getByRole('menuitem', { name: 'Comment on this' }))

    // The row used to be absent here, on the reasoning every formatting verb
    // still follows: the WORD under a caret is a guess about what the reader
    // meant, and storing it forever as though they had said it is wrong. A
    // BLOCK is not that guess — a paragraph is a unit a reader points at,
    // and it is what they have already pointed at by putting the caret in
    // it. Absence cost more than the guess would have: selecting a passage
    // on a phone is a drag between two handles, so on the surface with no
    // right-click there was no reachable way to open a conversation at all.
    expect(onComposeThread).toHaveBeenCalledWith({
      kind: 'text',
      quote: { exact: BODY },
      start: 0,
      end: BODY.length,
    })
  })

  it('offers no row at all when the host takes no threads', async () => {
    const { container, getByRole, queryByRole } = render(
      <MarkdownEditor initialViewMode="write" value={BODY} onChange={vi.fn()} />,
    )
    await selectFromStart(container, 9, 6)

    await userEvent.click(getByRole('button', { name: 'Editing actions' }))
    expect(queryByRole('menuitem', { name: 'Comment on this' })).toBeNull()
  })
})
