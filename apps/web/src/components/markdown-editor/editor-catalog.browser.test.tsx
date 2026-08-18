// The editor's verbs move out of the top strip and into the same banded
// catalog the canvas uses. Two things are being pinned here: that the verbs
// are REACHABLE without a keyboard, and that they act WITHOUT a selection —
// selecting text is the operation a phone cannot do comfortably, so every
// verb resolves its own scope (the caret's word, or the caret's line).
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

async function caretInto(container: HTMLElement, right: number): Promise<void> {
  const editable = container
    .querySelector('[data-testid="markdown-source-pane"]')
    ?.querySelector('[contenteditable="true"]')
  if (!editable) throw new Error('expected a contenteditable CodeMirror host')
  await userEvent.click(editable.querySelector('.cm-line') as HTMLElement)
  await userEvent.keyboard('{Control>}{Home}{/Control}')
  for (let i = 0; i < right; i++) await userEvent.keyboard('{ArrowRight}')
}

describe('the editor catalog (real browser)', () => {
  it('has no formatting verbs left in the top strip', () => {
    const { queryByRole } = render(<MarkdownEditor value="make this bold" onChange={() => {}} />)
    expect(queryByRole('button', { name: 'Bold' })).toBeNull()
    expect(queryByRole('button', { name: 'Italic' })).toBeNull()
    // What the strip keeps is what it is FOR: how this document is shown.
    expect(queryByRole('button', { name: 'Write' })).not.toBeNull()
  })

  it('bolds the word under the caret — no selection made first', async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor value="make this bold" onChange={onChange} />,
    )
    await caretInto(container, 6) // inside "this"

    await userEvent.click(getByRole('button', { name: 'More actions' }))
    await userEvent.click(getByRole('menuitem', { name: 'Bold' }))

    expect(onChange.mock.calls.at(-1)?.[0]).toBe('make **this** bold')
  })

  it('sets the heading level of the caret line, and pins the current level', async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor value="## weekly review" onChange={onChange} />,
    )
    await caretInto(container, 5)

    await userEvent.click(getByRole('button', { name: 'More actions' }))
    expect(getByRole('menuitemradio', { name: 'H2' }).getAttribute('aria-checked')).toBe('true')
    await userEvent.click(getByRole('menuitemradio', { name: 'H1' }))

    expect(onChange.mock.calls.at(-1)?.[0]).toBe('# weekly review')
  })

  it('toggles the task checkbox of the caret line', async () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <MarkdownEditor value="- [ ] ship it" onChange={onChange} />,
    )
    await caretInto(container, 8)

    await userEvent.click(getByRole('button', { name: 'More actions' }))
    await userEvent.click(getByRole('menuitem', { name: 'Toggle task' }))

    expect(onChange.mock.calls.at(-1)?.[0]).toBe('- [x] ship it')
  })

  it('right-click opens the catalog when there IS a selection', async () => {
    const { container, queryByTestId } = render(
      <MarkdownEditor value="make this bold" onChange={() => {}} />,
    )
    await caretInto(container, 5)
    await userEvent.keyboard('{Shift>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Shift}')

    const line = container.querySelector('.cm-line') as HTMLElement
    line.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))

    await waitFor(() => expect(queryByTestId('context-menu')).not.toBeNull())
  })

  // The platform's own menu (spellcheck, dictionary, translate) is worth more
  // than ours when there is nothing selected — so we must NOT preventDefault.
  it('right-click with no selection leaves the browser menu alone', async () => {
    const { container, queryByTestId } = render(
      <MarkdownEditor value="make this bold" onChange={() => {}} />,
    )
    await caretInto(container, 5)

    const line = container.querySelector('.cm-line') as HTMLElement
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    const notPrevented = line.dispatchEvent(event)

    expect(notPrevented).toBe(true)
    expect(event.defaultPrevented).toBe(false)
    expect(queryByTestId('context-menu')).toBeNull()
  })
})
