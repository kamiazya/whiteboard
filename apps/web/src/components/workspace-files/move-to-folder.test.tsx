// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

function renderWithFolders() {
  let rows = [
    { documentId: 'd1', path: 'design/login', name: 'Login flow', kind: 'spatial' as const },
    { documentId: 'd2', path: 'archive/old', name: 'Old', kind: 'spatial' as const },
    { documentId: 'd3', path: 'notes', name: 'Notes', kind: 'markdown' as const },
  ]
  const source = fakeFilesSource({
    listDocuments: async () => rows,
    renameDocumentPath: async (from, to) => {
      rows = rows.map((row) => (row.path === from ? { ...row, path: to } : row))
    },
  })
  render(<WorkspaceFilesPanel source={source} initialFolder="design" onOpenDocument={() => {}} />)
  return source
}

async function openPicker(name: string) {
  const card = (await screen.findAllByTestId('card-title'))
    .find((each) => each.textContent === name)
    ?.closest('button') as HTMLElement
  fireEvent.contextMenu(card, { clientX: 5, clientY: 5 })
  const menu = await screen.findByRole('menu', { name: 'Document actions' })
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to folder…' }))
  return screen.findByRole('dialog', { name: 'Move to folder' })
}

describe('moving a document to a folder from its menu', () => {
  it('lists the workspace folders and moves the document into the one picked', async () => {
    const source = renderWithFolders()
    const dialog = await openPicker('Login flow')

    const options = within(dialog)
      .getAllByRole('option')
      .map((each) => each.textContent)
    expect(options).toEqual(['Workspace', 'archive', 'New folder…'])

    fireEvent.click(within(dialog).getByRole('option', { name: 'archive' }))

    await waitFor(() =>
      expect(source.renameDocumentPath).toHaveBeenCalledWith('design/login', 'archive/login'),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() =>
      expect(screen.getAllByRole('status').map((each) => each.textContent)).toContain(
        'Moved Login flow to archive',
      ),
    )
  })

  it('moves to the workspace root', async () => {
    const source = renderWithFolders()
    const dialog = await openPicker('Login flow')
    fireEvent.click(within(dialog).getByRole('option', { name: 'Workspace' }))
    await waitFor(() =>
      expect(source.renameDocumentPath).toHaveBeenCalledWith('design/login', 'login'),
    )
  })

  it('makes a new folder by name and moves the document into it', async () => {
    const source = renderWithFolders()
    const dialog = await openPicker('Login flow')
    fireEvent.click(within(dialog).getByRole('option', { name: 'New folder…' }))
    fireEvent.change(within(dialog).getByLabelText('Folder name'), {
      target: { value: 'plans/q4' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
    await waitFor(() =>
      expect(source.renameDocumentPath).toHaveBeenCalledWith('design/login', 'plans/q4/login'),
    )
  })

  it('shows the keeper’s refusal and keeps the picker open', async () => {
    const source = renderWithFolders()
    source.renameDocumentPath.mockRejectedValueOnce(new Error('archive/login is taken'))
    const dialog = await openPicker('Login flow')
    fireEvent.click(within(dialog).getByRole('option', { name: 'archive' }))
    expect(await within(dialog).findByRole('alert')).toHaveProperty(
      'textContent',
      'archive/login is taken',
    )
  })
})

describe('moving a document to a named folder', () => {
  function renderNamed() {
    let rows: WorkspaceDocumentEntry[] = [
      { documentId: 'd1', path: 'design/login', name: 'Login flow', kind: 'spatial' },
      { documentId: 'd2', path: 'class/w6/notes', name: 'Notes', kind: 'markdown' },
    ]
    const names = new Map([
      ['class', 'Class'],
      ['class/w6', 'Week 6'],
    ])
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
    render(<WorkspaceFilesPanel source={source} initialFolder="design" onOpenDocument={() => {}} />)
    return source
  }

  it('lists each folder by its names, top down', async () => {
    renderNamed()
    const dialog = await openPicker('Login flow')
    await waitFor(() =>
      expect(
        within(dialog)
          .getAllByRole('option')
          .map((each) => each.textContent),
      ).toEqual(['Workspace', 'Class', 'Class / Week 6', 'New folder…']),
    )
  })

  it('nests a typed new folder at "/", naming each folder it makes', async () => {
    const source = renderNamed()
    const dialog = await openPicker('Login flow')
    fireEvent.click(within(dialog).getByRole('option', { name: 'New folder…' }))
    fireEvent.change(within(dialog).getByLabelText('Folder name'), {
      target: { value: 'Class/Week 7' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
    await waitFor(() =>
      expect(source.renameDocumentPath).toHaveBeenCalledWith('design/login', 'class/week-7/login'),
    )
    await waitFor(() => expect(source.setFolderName).toHaveBeenCalledWith('class/week-7', 'Week 7'))
    expect(source.setFolderName).toHaveBeenCalledTimes(1)
  })

  it('refuses a new folder a sibling folder already shows', async () => {
    const source = renderNamed()
    const dialog = await openPicker('Login flow')
    fireEvent.click(within(dialog).getByRole('option', { name: 'New folder…' }))
    fireEvent.change(within(dialog).getByLabelText('Folder name'), {
      target: { value: 'class/WEEK 6' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Another folder in "class" is already called "WEEK 6". Choose a name no other folder beside it has.',
    )
    expect(source.renameDocumentPath).not.toHaveBeenCalled()
  })
})
