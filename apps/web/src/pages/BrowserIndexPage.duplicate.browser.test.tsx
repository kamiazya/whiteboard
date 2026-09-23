/**
 * Duplicate from a browser-kept index ROW, on the real page.
 *
 * The row has a path and nothing open, so this is the wiring the page had to
 * grow: the panel renders Duplicate only when it is handed a handler, and the
 * copy has to appear in the list without anyone leaving and coming back. The
 * copy's own CONTENT is the shared function's contract
 * (`lib/duplicate-browser-document.test.ts`).
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { Loro } from 'loro-crdt'
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

claimIsolatedWhiteboardDb('browserindexpage-duplicate')

beforeEach(async () => {
  await clearWhiteboardDb()
})
afterEach(cleanup)

const titles = () => screen.getAllByTestId('card-title').map((each) => each.textContent)

it('offers Duplicate on a row and shows the copy in the list', async () => {
  const workspaceId = getBrowserWorkspaceId()
  const store = new LocalStoreDouble()
  const documentId = '0CFJNRVY147ADGKPSWZ258BEHM'
  await store.save({
    documentId,
    workspaceId,
    path: 'alpha',
    name: 'Alpha',
    updatedAt: '2026-09-01T00:00:00Z',
    kind: 'markdown',
  })
  // Real Loro bytes: the duplicate reads the source's record and refuses
  // content it cannot merge, so a placeholder here would fail the write
  // rather than the wiring this test is about.
  await store.loro.save(documentId, new Loro().export({ mode: 'snapshot' }))
  await new IdbDocumentIndex().createWorkspace({ workspaceId, segment: 'default' })

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
  await waitFor(() => expect(titles()).toEqual(['Alpha']))

  const card = (await screen.findByTestId('card-title')).closest('button')
  if (card === null) throw new Error('no button around the card')
  await userEvent.click(card, { button: 'right' })
  const menu = await screen.findByRole('menu', { name: 'Document actions' })
  await userEvent.click(within(menu).getByRole('menuitem', { name: 'Duplicate' }))

  await waitFor(() => expect(titles().sort()).toEqual(['Alpha', 'Alpha (copy)']), {
    timeout: 15_000,
  })
  // The copy is a second document, not a rename of the first.
  expect(screen.queryByRole('alert')).toBeNull()
})
