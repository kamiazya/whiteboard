// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

// A move is something done TO a document; unless that document is the one in
// the preview, the person's place in the browser is not part of it.

function renderWithMovableRows() {
  let rows = [
    { documentId: 'd1', path: 'design/login', name: 'Login flow', kind: 'spatial' as const },
    { documentId: 'd2', path: 'design/signup', name: 'Signup flow', kind: 'spatial' as const },
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

const card = async (name: string) =>
  (await screen.findAllByTestId('card-title'))
    .find((each) => each.textContent === name)
    ?.closest('button') as HTMLElement

async function moveFromMenu(name: string, to: string) {
  fireEvent.contextMenu(await card(name), { clientX: 5, clientY: 5 })
  const menu = await screen.findByRole('menu', { name: 'Document actions' })
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename…' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText(/^Path/), { target: { value: to } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}

const currentCrumb = () =>
  within(screen.getByRole('navigation', { name: 'Folder path' }))
    .getAllByRole('button')
    .find((each) => each.getAttribute('aria-current') === 'true')?.textContent

describe('moving a document from the list', () => {
  it('keeps the person in their folder when another document was the preview', async () => {
    renderWithMovableRows()
    fireEvent.click(await card('Signup flow'))

    await moveFromMenu('Login flow', 'archive/login')

    await waitFor(() => expect(screen.queryAllByTestId('card-title')).toHaveLength(1))
    expect(currentCrumb()).toBe('design')
    expect(screen.getByTestId('card-title').textContent).toBe('Signup flow')
  })

  it('follows the document when it was the one in the preview', async () => {
    renderWithMovableRows()
    fireEvent.click(await card('Login flow'))

    await moveFromMenu('Login flow', 'archive/login')

    await waitFor(() => expect(currentCrumb()).toBe('archive'))
  })
})
