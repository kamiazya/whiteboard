/**
 * Bulk delete on the REAL page, over real IndexedDB.
 *
 * The panel's own suite proves the selection raises one request with the
 * right paths; what only this layer proves is that the page LOOPS it — every
 * selected path really reaching the store — behind one confirmation that
 * names the count rather than a document.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../index.css'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import { BrowserIndexPage } from './BrowserIndexPage.js'

claimIsolatedWhiteboardDb('browserindexpage-bulk-delete')

beforeEach(async () => {
  await clearWhiteboardDb()
})
afterEach(cleanup)

const titles = () => screen.getAllByTestId('card-title').map((each) => each.textContent)

async function seedThree() {
  const workspaceId = getBrowserWorkspaceId()
  const store = new LocalStoreDouble()
  for (const [documentId, path] of [
    ['0CFJNRVY147ADGKPSWZ258BEHM', 'alpha'],
    ['0Z258BEHMQTX0369CFJNRVY147', 'beta'],
    ['069CFJNRVY147ADGKPSWZ258BE', 'gamma'],
  ] as const) {
    await store.save({
      documentId,
      workspaceId,
      path,
      name: path,
      updatedAt: '2026-09-01T00:00:00Z',
      kind: 'markdown',
    })
  }
  await new IdbDocumentIndex().createWorkspace({ workspaceId, segment: 'default' })
  return store
}

async function cardFor(name: string) {
  const title = (await screen.findAllByTestId('card-title')).find(
    (each) => each.textContent === name,
  )
  if (title === undefined) throw new Error(`no card titled ${name}`)
  const card = title.closest('button')
  if (card === null) throw new Error(`no button around ${name}`)
  return card
}

it('deletes every selected document behind one confirmation naming the count', async () => {
  const store = await seedThree()
  render(
    <MemoryRouter initialEntries={['/']}>
      <BrowserIndexPage
        index={store.index}
        loro={store.loro}
        pointer={store.pointer}
        clock={store.clock}
        onOpenDocument={vi.fn()}
      />
    </MemoryRouter>,
    { container: document.body },
  )
  await waitFor(() => expect(titles()).toHaveLength(3))

  // Enter selection from the card menu — the object surface both pointers
  // reach — then add a second card by a plain click.
  await userEvent.click(await cardFor('alpha'), { button: 'right' })
  const menu = await screen.findByRole('menu', { name: 'Document actions' })
  await userEvent.click(within(menu).getByRole('menuitem', { name: 'Select' }))
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  await userEvent.click(await cardFor('beta'))

  const bar = await screen.findByTestId('selection-bar')
  await waitFor(() => expect(bar.textContent).toContain('2 selected'))
  await userEvent.click(within(bar).getByRole('button', { name: 'Delete' }))

  const dialog = await screen.findByRole('alertdialog')
  expect(within(dialog).getByRole('heading').textContent).toBe('Delete 2 documents?')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 15_000 })
  await waitFor(() => expect(titles()).toEqual(['gamma']), { timeout: 15_000 })

  // NOT asserted here: that the trash holds both. The store double this page
  // is given implements no trash at all (`InMemoryDocumentIndex` has no
  // `listTrash`), so the section never renders — nothing to do with the
  // delete. Recovery is the SINGLE delete's existing contract, covered end to
  // end over the real index by `BrowserIndexPage.flow.browser.test.tsx`, and
  // a bulk delete routes every path through that same `index.deleteDocument`.
})
