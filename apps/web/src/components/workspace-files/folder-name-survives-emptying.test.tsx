// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { fakeFilesSource } from '../../test-utils/fake-files-source.js'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel.js'

afterEach(cleanup)

/**
 * A keeper that prunes a folder's name with the folder, the way the index
 * does once no document's path names it any more.
 */
function renderPruningKeeper() {
  let rows: WorkspaceDocumentEntry[] = [
    { documentId: 'd1', path: 'notes', name: 'Notes', kind: 'markdown' },
    { documentId: 'd2', path: 'trip/plan', name: 'Plan', kind: 'markdown' },
  ]
  const names = new Map([['trip', 'Trip 2026']])
  const source = fakeFilesSource({
    listDocuments: async () => rows,
    listFolderNames: async () => [...names].map(([path, name]) => ({ path, name })),
    setFolderName: async (path, name) => {
      if (name !== undefined) names.set(path, name)
    },
    renameDocumentPath: async (from, to) => {
      rows = rows.map((row) => (row.path === from ? { ...row, path: to } : row))
      for (const path of names.keys()) {
        if (!rows.some((row) => row.path.startsWith(`${path}/`))) names.delete(path)
      }
    },
  })
  render(<WorkspaceFilesPanel source={source} initialFolder="trip" onOpenDocument={() => {}} />)
  return { source, names }
}

async function moveVia(cardName: string, option: string) {
  const card = (await screen.findAllByTestId('card-title'))
    .find((each) => each.textContent === cardName)
    ?.closest('button') as HTMLElement
  fireEvent.contextMenu(card, { clientX: 5, clientY: 5 })
  const menu = await screen.findByRole('menu', { name: 'Document actions' })
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to folder…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Move to folder' })
  fireEvent.click(await within(dialog).findByRole('option', { name: option }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}

describe('a named folder emptied by a move', () => {
  it('keeps its name, and gives it back when a document returns', async () => {
    const { source, names } = renderPruningKeeper()
    await moveVia('Plan', 'Workspace')
    await waitFor(() => expect(names.has('trip')).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))

    await moveVia('Plan', 'Trip 2026')

    await waitFor(() => expect(source.setFolderName).toHaveBeenCalledWith('trip', 'Trip 2026'))
    const contents = screen.getByTestId('folder-contents')
    expect(
      await within(contents).findByRole('button', { name: 'Open folder Trip 2026' }),
    ).toBeTruthy()
  })
})
