import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

describe('NewDocumentMenu — name and location', () => {
  function openDialog() {
    open()
    return screen.findByTestId('new-document-specify')
  }

  // Progressive disclosure: the person who already knows where the document
  // goes pays one extra press, and the person who does not pays nothing.
  // Putting this form in front of EVERY create would tax the common case to
  // serve the rare one — and naming is hardest at the moment before the
  // thing exists, which is why it must not gate creation (ADR-0006 point 3).
  it('starts the path at the same address an unprompted create would use', async () => {
    render(<NewDocumentMenu onCreate={vi.fn()} defaultPath="design/untitled-3" />)
    fireEvent.pointerUp(await openDialog())

    const path = await screen.findByLabelText(/^Path/)
    expect((path as HTMLInputElement).value).toBe('design/untitled-3')
    // Submitting it untouched must land exactly where the plain menu entry
    // would have, or the dialog is a different feature wearing the same name.
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe('')
  })

  it('passes the typed name and path through, with the chosen kind', async () => {
    const onCreate = vi.fn()
    render(<NewDocumentMenu onCreate={onCreate} defaultPath="untitled" />)
    fireEvent.pointerUp(await openDialog())

    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: '週次メモ' } })
    fireEvent.change(screen.getByLabelText(/^Path/), { target: { value: 'notes/weekly' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Markdown note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(onCreate).toHaveBeenCalledWith('markdown', { path: 'notes/weekly', name: '週次メモ' })
  })

  it('sends no name when the field was left alone', async () => {
    const onCreate = vi.fn()
    render(<NewDocumentMenu onCreate={onCreate} defaultPath="untitled" />)
    fireEvent.pointerUp(await openDialog())

    fireEvent.click(await screen.findByRole('button', { name: 'Create' }))
    expect(onCreate).toHaveBeenCalledWith('spatial', { path: 'untitled', name: undefined })
  })

  // Without a defaultPath there is nothing to prefill the form with, so the
  // entry that opens it must not appear either.
  it('offers no such entry when the host cannot supply a starting path', async () => {
    render(<NewDocumentMenu onCreate={vi.fn()} />)
    open()
    await screen.findByTestId('new-document-spatial')
    expect(screen.queryByTestId('new-document-specify')).toBeNull()
  })
})

describe('NewDocumentMenu — the dialog survives a refusal', () => {
  async function openDialogWith(onCreate: (...args: never[]) => unknown, error?: string) {
    render(
      <NewDocumentMenu
        onCreate={onCreate as never}
        defaultPath="untitled"
        createError={error ?? null}
      />,
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: /new document/i }), { button: 0 })
    fireEvent.pointerUp(await screen.findByTestId('new-document-specify'))
    return screen.findByRole('dialog')
  }

  // A path collision is the likeliest refusal, and it is exactly the one the
  // person can fix — but only if the form they typed into is still there.
  // Closing on submit threw the typed name and path away and left the reason
  // behind a dialog that no longer existed.
  it('stays open when the create is refused, with the reason in it', async () => {
    const onCreate = vi.fn(() => Promise.reject(new Error('already exists')))
    await openDialogWith(onCreate)

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).not.toBeNull()
  })

  it('closes once the create succeeds', async () => {
    const onCreate = vi.fn(() => Promise.resolve())
    await openDialogWith(onCreate)

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  // Submitting an empty Path returned with no output at all: Create looked
  // like a dead button. A field the form refuses has to say so.
  it('says why an empty path is refused instead of doing nothing', async () => {
    const onCreate = vi.fn()
    await openDialogWith(onCreate)

    fireEvent.change(screen.getByLabelText(/^Path/), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(onCreate).not.toHaveBeenCalled()
    expect((await screen.findByRole('alert')).textContent).toMatch(/path/i)
  })
})
