import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { MarkdownEditor } from './MarkdownEditor.js'

/**
 * A markdown document's undo, for hands without a keyboard.
 *
 * CodeMirror's history has always been there and ⌘/Ctrl+Z has always run it
 * — but a keymap is not an affordance. A phone has no chord to press, so a
 * markdown document had no way to undo at all, while a canvas has had a pair
 * of buttons in its dock the whole time.
 *
 * A real browser rather than jsdom: what is under test is CodeMirror's own
 * history reacting to a real key sequence, which jsdom's input handling does
 * not reproduce.
 */

afterEach(() => {
  cleanup()
  window.localStorage.removeItem('whiteboard.markdown-view-mode')
})

async function focusSource(getByTestId: (id: string) => HTMLElement) {
  await focusEditable(() =>
    getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]'),
  )
}

describe('markdown undo and redo, without a keyboard', () => {
  it('undoes the typing a finger cannot take back with a chord, and redoes it', async () => {
    const onChange = vi.fn()
    const { getByTestId, getByRole } = render(
      <MarkdownEditor initialViewMode="split" value="" onChange={onChange} />,
    )

    await focusSource(getByTestId)
    await userEvent.keyboard('first')
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toBe('first'))

    const undo = getByRole('button', { name: 'Undo' })
    // Icon-first, per DESIGN.md's object-action rule.
    expect(undo.textContent).toBe('')
    await userEvent.click(undo)
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toBe(''))

    await userEvent.click(getByRole('button', { name: 'Redo' }))
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toBe('first'))
  })

  it('leaves the document alone when there is nothing to undo', async () => {
    const onChange = vi.fn()
    const { getByRole } = render(
      <MarkdownEditor initialViewMode="split" value="untouched" onChange={onChange} />,
    )

    await userEvent.click(getByRole('button', { name: 'Undo' }))
    // A no-op, not a crash and not an empty document: CodeMirror's history
    // is empty, so the command declines.
    expect(onChange.mock.calls.every(([next]) => next === 'untouched')).toBe(true)
  })

  it('hides both when there is no source pane to act on, as Read mode has none', async () => {
    const { queryByRole } = render(
      <MarkdownEditor initialViewMode="read" value="# Title" onChange={vi.fn()} />,
    )
    expect(queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(queryByRole('button', { name: 'Redo' })).toBeNull()
  })
})
