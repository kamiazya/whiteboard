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

async function seedOne() {
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
  return store
}

function renderPage(store: LocalStoreDouble, index = store.index) {
  render(
    <MemoryRouter initialEntries={['/']}>
      <BrowserIndexPage
        index={index}
        loro={store.loro}
        pointer={store.pointer}
        clock={store.clock}
        onOpenDocument={vi.fn()}
      />
    </MemoryRouter>,
    { container: document.body },
  )
}

async function duplicateTheOnlyRow() {
  const card = (await screen.findByTestId('card-title')).closest('button')
  if (card === null) throw new Error('no button around the card')
  await userEvent.click(card, { button: 'right' })
  const menu = await screen.findByRole('menu', { name: 'Document actions' })
  await userEvent.click(within(menu).getByRole('menuitem', { name: 'Duplicate' }))
}

it('offers Duplicate on a row and shows the copy in the list', async () => {
  const store = await seedOne()
  renderPage(store)
  await waitFor(() => expect(titles()).toEqual(['Alpha']))

  await duplicateTheOnlyRow()

  await waitFor(() => expect(titles().sort()).toEqual(['Alpha', 'Alpha (copy)']), {
    timeout: 15_000,
  })
  // The copy is a second document, not a rename of the first.
  expect(screen.queryByRole('alert')).toBeNull()
})

/**
 * A copy that was really made must never be reported as a failed duplicate:
 * that reading invites a second press, and the second copy is real too. What
 * the page says instead is the LIST's own refusal, which is whose failure it
 * actually is.
 */
it('reports a refusing list as a list failure, not as a failed duplicate', async () => {
  const store = await seedOne()
  // Listing refuses from the moment the row is on screen: the page's own
  // re-read is what fails, while the duplicate itself does not — both reads
  // inside `duplicateBrowserDocument` are already tolerant of a listing that
  // refuses (they only number the copy's name and path).
  let refuseListing = false
  const flaky = new Proxy(store.index, {
    get(target, prop) {
      if (prop !== 'listDocuments') {
        const held = Reflect.get(target, prop)
        // BOUND to the target: the index keeps private fields, and a method
        // invoked with the proxy as `this` cannot read them — which fails
        // the first render rather than the read this case is about.
        return typeof held === 'function' ? held.bind(target) : held
      }
      return async (...args: Parameters<typeof store.index.listDocuments>) => {
        if (refuseListing) throw new Error('the listing refused')
        return target.listDocuments(...args)
      }
    },
  })
  renderPage(store, flaky)
  await waitFor(() => expect(titles()).toEqual(['Alpha']))
  refuseListing = true

  await duplicateTheOnlyRow()

  const alert = await screen.findByRole('alert', undefined, { timeout: 15_000 })
  expect(alert.textContent).toContain('Failed to load documents')
  expect(alert.textContent).not.toContain('Failed to duplicate')
  // And the copy really is there, which is what makes that wording the right
  // one. Read straight off the index, not through the refusing proxy.
  refuseListing = false
  expect(await store.index.listDocuments({ workspaceId: getBrowserWorkspaceId() })).toHaveLength(2)
})
