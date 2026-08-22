// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

// One dialog for a document's two addresses. The name lives in the
// workspace and may be empty (readers fall back to the path's last
// segment); the path is placement. Neither derives the other (ADR-0008).

afterEach(cleanup)

const entry = {
  documentId: 'd1',
  path: 'design/login',
  name: 'Login flow',
  kind: 'spatial' as const,
}

function renderPanel(overrides: Parameters<typeof fakeFilesSource>[0] = {}) {
  const source = fakeFilesSource({ listDocuments: async () => [entry], ...overrides })
  render(<WorkspaceFilesPanel source={source} onOpenDocument={() => {}} />)
  return source
}

// The fixture lives one folder down, which is the interesting case: the
// dialog's Path field must show the FULL path, not the segment.
async function selectCard() {
  fireEvent.click((await screen.findAllByRole('button', { name: 'Open folder design' }))[0]!)
  await waitFor(() => {
    expect(
      screen.queryAllByTestId('card-title').some((el) => el.textContent === 'Login flow'),
    ).toBe(true)
  })
  const card = screen.getAllByTestId('card-title').find((n) => n.textContent === 'Login flow')
  fireEvent.click(card?.closest('button') as HTMLElement)
}

async function openDialog() {
  await selectCard()
  fireEvent.click(await screen.findByRole('button', { name: /Rename/ }))
  return screen.findByRole('dialog')
}

describe('rename dialog', () => {
  it('opens prefilled with both addresses and explains each', async () => {
    renderPanel()
    const dialog = await openDialog()
    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe('Login flow')
    expect((within(dialog).getByLabelText(/^Path/) as HTMLInputElement).value).toBe('design/login')
    // Each field says what it is — the answer to "why two?" lives here.
    expect(within(dialog).getByText(/What it is called/)).toBeTruthy()
    expect(within(dialog).getByText(/Where it lives in the workspace/)).toBeTruthy()
  })

  it('renames without moving when only the name changed', async () => {
    const source = renderPanel()
    const dialog = await openDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Sign-in flow' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(source.setDocumentName).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'design/login' }),
        'Sign-in flow',
      ),
    )
    expect(source.renameDocumentPath).not.toHaveBeenCalled()
  })

  it('clears the name as absence, so readers fall back to the segment', async () => {
    const source = renderPanel()
    const dialog = await openDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: '  ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(source.setDocumentName).toHaveBeenCalledWith(expect.anything(), undefined),
    )
  })

  it('moves without touching the name when only the path changed', async () => {
    const source = renderPanel()
    const dialog = await openDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Path/), {
      target: { value: 'archive/login' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(source.renameDocumentPath).toHaveBeenCalledWith('design/login', 'archive/login'),
    )
    expect(source.setDocumentName).not.toHaveBeenCalled()
  })

  it('applies both when both changed', async () => {
    const source = renderPanel()
    const dialog = await openDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Archived' } })
    fireEvent.change(within(dialog).getByLabelText(/^Path/), { target: { value: 'archive/login' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(source.setDocumentName).toHaveBeenCalledWith(expect.anything(), 'Archived'),
    )
    await waitFor(() =>
      expect(source.renameDocumentPath).toHaveBeenCalledWith('design/login', 'archive/login'),
    )
  })

  // The server names the PRODUCED path that collided, which on a subtree
  // move is often not the one typed here.
  it("shows the server's own refusal and stays open", async () => {
    renderPanel({
      renameDocumentPath: async () => {
        throw new Error('Path "archive/login/notes" already exists')
      },
    })
    const dialog = await openDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Path/), { target: { value: 'archive/login' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('archive/login/notes')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('the card context menu opens the same dialog', async () => {
    renderPanel()
    fireEvent.click((await screen.findAllByRole('button', { name: 'Open folder design' }))[0]!)
    await waitFor(() => {
      expect(
        screen.queryAllByTestId('card-title').some((el) => el.textContent === 'Login flow'),
      ).toBe(true)
    })
    const card = screen
      .getAllByTestId('card-title')
      .find((n) => n.textContent === 'Login flow')
      ?.closest('button') as HTMLElement
    fireEvent.contextMenu(card, { clientX: 20, clientY: 20 })
    const menu = await screen.findByRole('menu', { name: 'Document actions' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename…' }))
    const dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByLabelText(/^Path/) as HTMLInputElement).value).toBe('design/login')
  })

  it('cancelling leaves both addresses untouched', async () => {
    const source = renderPanel()
    const dialog = await openDialog()
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Nope' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(source.setDocumentName).not.toHaveBeenCalled()
    expect(source.renameDocumentPath).not.toHaveBeenCalled()
  })
})
