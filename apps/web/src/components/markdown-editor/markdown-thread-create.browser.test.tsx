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

  it('offers no row with nothing selected, because there is no passage to quote', async () => {
    const onComposeThread = vi.fn()
    const { container, getByRole, queryByRole } = render(
      <MarkdownEditor
        initialViewMode="write"
        value={BODY}
        onChange={vi.fn()}
        onComposeThread={onComposeThread}
      />,
    )
    await selectFromStart(container, 9, 0)

    await userEvent.click(getByRole('button', { name: 'Editing actions' }))
    // Unlike every formatting verb, this one cannot resolve its own scope
    // from the caret: the word under it is a guess about what the reader
    // meant, and it would be stored as though they had said it.
    expect(queryByRole('menuitem', { name: 'Comment on this' })).toBeNull()
    // The rest of the catalog is unaffected — this is one absent row, not a
    // catalog that failed to open.
    expect(queryByRole('menuitem', { name: 'Bold' })).not.toBeNull()
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
