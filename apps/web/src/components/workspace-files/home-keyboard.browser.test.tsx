/**
 * The keyboard's way to a folder's and a document's own actions on the home
 * list, in a real browser: F2 renames, Shift+F10 and the Menu key open the
 * object's menu, wherever the object has focus.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../../index.css'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

function renderPanel() {
  let rows: WorkspaceDocumentEntry[] = [
    { documentId: 'd1', path: 'notes', name: 'Notes', kind: 'markdown' },
    { documentId: 'd2', path: 'archive/old', name: 'Old', kind: 'markdown' },
  ]
  const source = fakeFilesSource({
    listDocuments: async () => rows,
    listFolderNames: async () => [],
    setFolderName: async () => {},
    setDocumentName: async (entry, name) => {
      rows = rows.map((row) =>
        row.documentId === entry.documentId ? { ...row, ...(name ? { name } : {}) } : row,
      )
    },
  })
  render(<WorkspaceFilesPanel source={source} onOpenDocument={vi.fn()} />, {
    container: document.body,
  })
}

async function treeRow() {
  const tree = await screen.findByRole('tree', { name: 'Workspace folders' })
  return within(tree).findByRole('treeitem', { name: 'archive' })
}

describe('a folder in the tree, by keyboard', () => {
  it('F2 on its button opens Rename folder', async () => {
    renderPanel()
    const row = await treeRow()
    within(row).getByRole('button', { name: 'Open folder archive' }).focus()
    await userEvent.keyboard('{F2}')
    expect(await screen.findByRole('dialog', { name: 'Rename folder' })).toBeTruthy()
  })

  it('F2 on the focused tree item opens Rename folder', async () => {
    renderPanel()
    ;(await treeRow()).focus()
    await userEvent.keyboard('{F2}')
    expect(await screen.findByRole('dialog', { name: 'Rename folder' })).toBeTruthy()
  })

  it('Shift+F10 on the focused tree item opens its menu', async () => {
    renderPanel()
    ;(await treeRow()).focus()
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    const menu = await screen.findByRole('menu', { name: 'Folder actions' })
    expect(within(menu).getByRole('menuitem', { name: 'Rename…' })).toBeTruthy()
  })

  it('the Menu key on the focused tree item opens its menu', async () => {
    renderPanel()
    ;(await treeRow()).focus()
    await userEvent.keyboard('{ContextMenu}')
    expect(await screen.findByRole('menu', { name: 'Folder actions' })).toBeTruthy()
  })

  it('says its button has a menu, and shows a visible actions control', async () => {
    renderPanel()
    const row = await treeRow()
    const open = within(row).getByRole('button', { name: 'Open folder archive' })
    expect(open.getAttribute('aria-keyshortcuts')).toBe('F2 Shift+F10')
    const more = within(row).getByRole('button', { name: 'archive actions' })
    expect(more.getAttribute('aria-haspopup')).toBe('menu')
    await userEvent.click(more)
    expect(await screen.findByRole('menu', { name: 'Folder actions' })).toBeTruthy()
  })
})

describe('a document card, by keyboard', () => {
  it('F2 opens Rename and the saved rename is announced', async () => {
    renderPanel()
    const card = (await screen.findAllByTestId('card-title'))
      .find((each) => each.textContent === 'Notes')
      ?.closest('button') as HTMLElement
    card.focus()
    await userEvent.keyboard('{F2}')
    const dialog = await screen.findByRole('dialog')
    const name = within(dialog).getByLabelText(/^Name/)
    await userEvent.tripleClick(name)
    await userEvent.keyboard('Minutes{Enter}')
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('status')
          .some((each) => each.textContent === 'Renamed Notes to Minutes'),
      ).toBe(true),
    )
  })
})
