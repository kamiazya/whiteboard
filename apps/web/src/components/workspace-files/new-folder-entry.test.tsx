// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

function renderPanel(initialFolder = '') {
  let rows: WorkspaceDocumentEntry[] = [
    { documentId: 'd1', path: 'notes', name: 'Notes', kind: 'markdown' },
  ]
  const names = new Map<string, string>()
  const source = fakeFilesSource({
    listDocuments: async () => rows,
    listFolderNames: async () => [...names].map(([path, name]) => ({ path, name })),
    setFolderName: async (path, name) => {
      if (name !== undefined) names.set(path, name)
    },
    createDocument: async (path, kind, name) => {
      rows = [...rows, { documentId: `d${rows.length + 1}`, path, kind, ...(name ? { name } : {}) }]
      return path
    },
    renameDocumentPath: async (from, to) => {
      rows = rows.map((row) => (row.path === from ? { ...row, path: to } : row))
    },
  })
  render(
    <WorkspaceFilesPanel source={source} initialFolder={initialFolder} onOpenDocument={() => {}} />,
  )
  return { source }
}

async function newFolderFromToolbar(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'New folder' }))
  const dialog = await screen.findByRole('dialog', { name: 'New folder' })
  fireEvent.change(within(dialog).getByLabelText('Folder name'), { target: { value: name } })
  return dialog
}

describe('making a folder from the workspace root', () => {
  it('offers a labelled New folder that says up front when the folder is kept', async () => {
    renderPanel()
    const dialog = await newFolderFromToolbar('Site visits')
    expect(within(dialog).getByText(/appears in the list once a document is in it/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create folder' }))

    const trail = await screen.findByRole('navigation', { name: 'Folder path' })
    await waitFor(() =>
      expect(within(trail).getByRole('button', { name: 'Site visits' })).toBeTruthy(),
    )
  })
})

describe('an empty new folder', () => {
  it('creates a note into it from its own view and keeps its name', async () => {
    const { source } = renderPanel()
    const dialog = await newFolderFromToolbar('Site visits')
    fireEvent.submit(within(dialog).getByLabelText('Folder name').closest('form') as HTMLElement)

    const contents = await screen.findByTestId('folder-contents')
    expect(await within(contents).findByRole('button', { name: 'New canvas here' })).toBeTruthy()
    fireEvent.click(within(contents).getByRole('button', { name: 'New note here' }))

    await waitFor(() =>
      expect(source.createDocument).toHaveBeenCalledWith(
        expect.stringMatching(/^site-visits\//),
        'markdown',
        undefined,
      ),
    )
    await waitFor(() =>
      expect(source.setFolderName).toHaveBeenCalledWith('site-visits', 'Site visits'),
    )
  })
})

describe('filing existing documents into an empty new folder', () => {
  it('moves the documents picked from its own view, which keeps the folder', async () => {
    const { source } = renderPanel()
    fireEvent.submit(
      within(await newFolderFromToolbar('Site visits'))
        .getByLabelText('Folder name')
        .closest('form') as HTMLElement,
    )
    const contents = await screen.findByTestId('folder-contents')
    fireEvent.click(await within(contents).findByRole('button', { name: 'Move documents here…' }))

    const dialog = await screen.findByRole('dialog', { name: 'Move documents here' })
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Notes/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here' }))

    await waitFor(() =>
      expect(source.renameDocumentPath).toHaveBeenCalledWith('notes', 'site-visits/notes'),
    )
    await waitFor(() =>
      expect(source.setFolderName).toHaveBeenCalledWith('site-visits', 'Site visits'),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
