import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewDocumentMenu } from './NewDocumentMenu.js'

// Radix DropdownMenuTrigger opens on pointerDown (not click); DropdownMenuItem
// selects on pointerUp. Matches WorkspaceTopBar.test.tsx's helper.
afterEach(cleanup)

function open() {
  fireEvent.pointerDown(screen.getByRole('button', { name: /new document/i }), { button: 0 })
}

describe('NewDocumentMenu', () => {
  // The point of the whole control: `kind` cannot be changed after creation
  // (nothing in the codebase writes it twice), so the choice that fixes it
  // must not sit behind an unlabeled icon. Both kinds carry visible TEXT,
  // which is also the only route to their names on a touch screen — a
  // tooltip needs a pointer that a phone does not have.
  it('names both kinds in text, not by icon alone', async () => {
    render(<NewDocumentMenu onCreate={vi.fn()} />)
    open()

    expect((await screen.findByTestId('new-document-spatial')).textContent).toContain('Canvas')
    expect(screen.getByTestId('new-document-markdown').textContent).toContain('Markdown note')
  })

  it('creates the kind that was picked', async () => {
    const onCreate = vi.fn()
    render(<NewDocumentMenu onCreate={onCreate} />)

    open()
    fireEvent.pointerUp(await screen.findByTestId('new-document-spatial'))
    expect(onCreate).toHaveBeenCalledWith('spatial')

    open()
    fireEvent.pointerUp(await screen.findByTestId('new-document-markdown'))
    expect(onCreate).toHaveBeenCalledWith('markdown')
  })

  // WCAG 2.5.3: the accessible name must contain the visible label, or
  // "click New" fails for anyone driving the page by voice.
  it('keeps the visible label inside the accessible name', () => {
    render(<NewDocumentMenu onCreate={vi.fn()} />)
    const trigger = screen.getByRole('button', { name: /new document/i })
    expect(trigger.getAttribute('aria-label')).toBe('New document')
    expect(trigger.textContent).toContain('New')
  })

  // The guard sits on the ITEMS, not on the trigger: with a menu in the way
  // the second press lands on an item, and reading the menu while a create
  // resolves is harmless. A disabled trigger would also be untestable here —
  // jsdom dispatches pointerdown on a disabled button where a real browser
  // suppresses it.
  it('refuses a second create while one is in flight', async () => {
    const onCreate = vi.fn()
    render(<NewDocumentMenu onCreate={onCreate} disabled />)
    open()

    fireEvent.pointerUp(await screen.findByTestId('new-document-spatial'))
    expect(onCreate).not.toHaveBeenCalled()
  })
})
