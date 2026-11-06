/**
 * Where focus lands when a folder dialog closes, in a real browser: Radix
 * hands focus back to whatever opened the dialog, and when that was a menu
 * item that has since unmounted, focus falls to <body> and the next Tab
 * starts over from the app header.
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
  const names = new Map<string, string>()
  const source = fakeFilesSource({
    listDocuments: async () => rows,
    listFolderNames: async () => [...names].map(([path, name]) => ({ path, name })),
    setFolderName: async (path, name) => {
      if (name !== undefined) names.set(path, name)
    },
    renameDocumentPath: async (from, to) => {
      rows = rows.map((row) => (row.path === from ? { ...row, path: to } : row))
    },
  })
  render(<WorkspaceFilesPanel source={source} onOpenDocument={vi.fn()} />, {
    container: document.body,
  })
  return source
}

async function makeFolder(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: 'New folder' }))
  const dialog = await screen.findByRole('dialog', { name: 'New folder' })
  await userEvent.type(within(dialog).getByLabelText('Folder name'), `${name}{Enter}`)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}

function statusSays(text: string) {
  return screen.getAllByRole('status').some((each) => each.textContent === text)
}

describe('focus after a folder dialog closes', () => {
  it('lands on the new folder in the trail and says it is empty', async () => {
    renderPanel()
    await makeFolder('Design docs')
    await waitFor(() => {
      const holder = document.activeElement
      expect(holder?.getAttribute('aria-current')).toBe('true')
      expect(holder?.textContent).toBe('Design docs')
    })
    expect(statusSays('In Design docs, empty')).toBe(true)
  })

  it('lands on the folder a document was moved to from its menu', async () => {
    renderPanel()
    const title = (await screen.findAllByTestId('card-title')).find(
      (each) => each.textContent === 'Notes',
    )
    await userEvent.click(title?.closest('button') as HTMLElement, { button: 'right' })
    const menu = await screen.findByRole('menu', { name: 'Document actions' })
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Move to folder…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move to folder' })
    await userEvent.click(within(dialog).getByRole('option', { name: 'archive' }))
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-folder-path')).toBe('archive'),
    )
    expect(statusSays('Moved Notes to archive')).toBe(true)
  })

  it('lands on the document moved into an empty folder from inside it', async () => {
    renderPanel()
    await makeFolder('Design docs')
    await userEvent.click(await screen.findByRole('button', { name: 'Move documents here…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move documents here' })
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Notes/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move here' }))
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-doc-path')).toBe('design-docs/notes'),
    )
  })
})

async function openCardMenuItem(title: string, item: string) {
  const card = (await screen.findAllByTestId('card-title')).find(
    (each) => each.textContent === title,
  )
  await userEvent.click(card?.closest('button') as HTMLElement, { button: 'right' })
  const menu = await screen.findByRole('menu', { name: 'Document actions' })
  await userEvent.click(within(menu).getByRole('menuitem', { name: item }))
}

describe('focus after a dialog is dismissed', () => {
  it('Escape on New folder returns to the New folder button', async () => {
    renderPanel()
    const opener = await screen.findByRole('button', { name: 'New folder' })
    await userEvent.click(opener)
    await screen.findByRole('dialog', { name: 'New folder' })
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('Cancel on New folder returns to the New folder button', async () => {
    renderPanel()
    const opener = await screen.findByRole('button', { name: 'New folder' })
    await userEvent.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'New folder' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('Escape on a folder rename returns to that folder', async () => {
    renderPanel()
    const contents = await screen.findByTestId('folder-contents')
    const folder = await within(contents).findByRole('button', { name: 'Open folder archive' })
    await userEvent.click(folder, { button: 'right' })
    const menu = await screen.findByRole('menu', { name: 'Folder actions' })
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Rename…' }))
    await screen.findByRole('dialog', { name: 'Rename folder' })
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('data-folder-path')).toBe('archive'),
    )
  })

  it('Escape on a card Rename… returns to the card', async () => {
    renderPanel()
    await openCardMenuItem('Notes', 'Rename…')
    await screen.findByRole('dialog')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(document.activeElement?.getAttribute('data-doc-path')).toBe('notes'))
  })

  it('Escape on a card Move to folder… returns to the card', async () => {
    renderPanel()
    await openCardMenuItem('Notes', 'Move to folder…')
    await screen.findByRole('dialog', { name: 'Move to folder' })
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(document.activeElement?.getAttribute('data-doc-path')).toBe('notes'))
  })
})
