/**
 * Renaming and moving a document in a REAL browser, driven from the card's
 * own context menu.
 *
 * The jsdom suite beside this one proves the two addresses are independent
 * and that a refusal is shown — nine cases over the same panel. What only a
 * real browser proves is the CHAIN: a real right-click opens a real Radix
 * menu, its item opens the dialog, the dialog's controlled fields take real
 * keystrokes, and the submit reaches the store. It is the one WRITE in this
 * panel's dialog family with no browser coverage, while delete and bulk
 * delete have theirs — and a rename that silently did nothing would read to
 * a user exactly like one that worked.
 *
 * The dialog re-primes its fields from props on every open, so nothing here
 * holds an element across an action that can remount it: every element is
 * queried inside the assertion or immediately before the keystroke that
 * uses it.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../../index.css'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

// One folder down on purpose: the Path field must show the WHOLE path, and
// a move has somewhere to move from.
const entry = {
  documentId: 'd1',
  path: 'design/login',
  name: 'Login flow',
  kind: 'spatial' as const,
}

function renderPanel(overrides: Parameters<typeof fakeFilesSource>[0] = {}) {
  const source = fakeFilesSource({ listDocuments: async () => [entry], ...overrides })
  render(<WorkspaceFilesPanel source={source} onOpenDocument={vi.fn()} />, {
    container: document.body,
  })
  return source
}

async function cardTitled(text: string) {
  const title = (await screen.findAllByTestId('card-title')).find(
    (each) => each.textContent === text,
  )
  if (title === undefined) throw new Error(`no card titled ${text}`)
  const card = title.closest('button')
  if (card === null) throw new Error(`no button around ${text}`)
  return card
}

async function openRenameFromMenu() {
  // The folder is offered in more than one place (the tree and the grid);
  // either opens it, so the first is as good as a disambiguating query and
  // does not pin which surface renders it.
  const folders = await screen.findAllByRole('button', { name: 'Open folder design' })
  await userEvent.click(folders[0] as HTMLElement)
  await userEvent.click(await cardTitled('Login flow'))
  await userEvent.click(await cardTitled('Login flow'), { button: 'right' })
  const menu = await screen.findByRole('menu', { name: 'Document actions' })
  await userEvent.click(within(menu).getByRole('menuitem', { name: /Rename/ }))
  // The menu has to be GONE before the dialog is driven: a click landing
  // while it dismisses is consumed, which reads as a field that will not
  // take input (integrator-flow.md's seventh flake shape).
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  return screen.findByRole('dialog')
}

it('renames and moves from the card menu, and the store sees both', async () => {
  const source = renderPanel()
  const dialog = await openRenameFromMenu()

  // Prefilled with what the document already is, both addresses in full.
  expect(within(dialog).getByRole('textbox', { name: /Name/ })).toHaveValue('Login flow')

  const name = within(dialog).getByRole('textbox', { name: /Name/ })
  await userEvent.clear(name)
  // ASCII only: a character with no keycode is synthesized separately and is
  // the one that goes missing under load.
  await userEvent.type(name, 'Sign-in flow')

  const path = within(dialog).getByRole('textbox', { name: /Path/ })
  await userEvent.clear(path)
  await userEvent.type(path, 'auth/login')

  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

  // The panel hands the whole entry, not an id: asserting on the object is
  // what pins that the row it renames is the one the menu was opened on.
  await waitFor(() =>
    expect(source.setDocumentName).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'd1', path: 'design/login' }),
      'Sign-in flow',
    ),
  )
  await waitFor(() =>
    expect(source.renameDocumentPath).toHaveBeenCalledWith('design/login', 'auth/login'),
  )
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('keeps the dialog open and shows the reason when the move is refused', async () => {
  const source = renderPanel({
    renameDocumentPath: async () => {
      throw new Error('a document already lives at auth/login')
    },
  })
  const dialog = await openRenameFromMenu()

  const path = within(dialog).getByRole('textbox', { name: /Path/ })
  await userEvent.clear(path)
  await userEvent.type(path, 'auth/login')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

  // Queried inside the assertion rather than held: the submit re-renders the
  // form around the alert it is waiting for.
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('already lives at auth/login'),
  )
  expect(screen.queryByRole('dialog')).not.toBeNull()
  expect(source.renameDocumentPath).toHaveBeenCalledTimes(1)
})
