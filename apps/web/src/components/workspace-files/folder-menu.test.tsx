// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

function renderWithFolder() {
  let rows = [
    { documentId: 'd1', path: 'design/login', name: 'Login flow', kind: 'spatial' as const },
    { documentId: 'd2', path: 'design/ui/button', name: 'Button', kind: 'spatial' as const },
  ]
  const source = fakeFilesSource({
    listDocuments: async () => rows,
    renameDocumentPath: async (from, to) => {
      rows = rows.map((row) =>
        row.path === from || row.path.startsWith(`${from}/`)
          ? { ...row, path: to + row.path.slice(from.length) }
          : row,
      )
    },
  })
  render(<WorkspaceFilesPanel source={source} onOpenDocument={() => {}} />)
  return source
}

async function openFolderMenu() {
  const card = within(await screen.findByTestId('folder-contents')).getByRole('button', {
    name: 'Open folder design',
  })
  fireEvent.contextMenu(card, { clientX: 5, clientY: 5 })
  return screen.findByRole('menu', { name: 'Folder actions' })
}

describe('a folder’s own menu', () => {
  it('renames the folder, moving everything under it with one path move', async () => {
    const source = renderWithFolder()
    const menu = await openFolderMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rename folder' })
    const field = within(dialog).getByLabelText('Folder name') as HTMLInputElement
    expect(field.value).toBe('design')
    fireEvent.change(field, { target: { value: 'plans' } })
    fireEvent.submit(field.closest('form') as HTMLFormElement)
    await waitFor(() => expect(source.renameDocumentPath).toHaveBeenCalledWith('design', 'plans'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(
      (await screen.findAllByRole('button', { name: 'Open folder plans' })).length,
    ).toBeGreaterThan(0)
  })

  it('refuses a folder name with a slash before asking the keeper', async () => {
    const source = renderWithFolder()
    const menu = await openFolderMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rename folder' })
    const field = within(dialog).getByLabelText('Folder name')
    fireEvent.change(field, { target: { value: 'a/b' } })
    fireEvent.submit(field.closest('form') as HTMLFormElement)
    expect(await within(dialog).findByRole('alert')).toBeTruthy()
    expect(source.renameDocumentPath).not.toHaveBeenCalled()
  })

  it('opens a new subfolder to put documents in', async () => {
    renderWithFolder()
    const menu = await openFolderMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'New subfolder…' }))
    const dialog = await screen.findByRole('dialog', { name: 'New subfolder' })
    const field = within(dialog).getByLabelText('Folder name')
    fireEvent.change(field, { target: { value: 'drafts' } })
    fireEvent.submit(field.closest('form') as HTMLFormElement)
    const trail = await screen.findByRole('navigation', { name: 'Folder path' })
    await waitFor(() => expect(within(trail).getByRole('button', { name: 'drafts' })).toBeTruthy())
  })
})
