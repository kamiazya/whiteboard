/**
 * The lane on the REAL page, over real IndexedDB and the page's own handle.
 *
 * The panel's own suite proves the lane renders and that opening records;
 * what only this layer proves is that `BrowserIndexPage` passes a workspace
 * handle at all. Without one the panel records nothing and the lane is
 * permanently absent — a wiring gap every component-level test passes
 * through, because they supply the handle themselves.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../index.css'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { STORAGE_KEY } from '../lib/recent-documents.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import { BrowserIndexPage } from './BrowserIndexPage.js'

claimIsolatedWhiteboardDb('browserindexpage-recent-lane')

beforeEach(async () => {
  await clearWhiteboardDb()
  localStorage.removeItem(STORAGE_KEY)
})
afterEach(() => {
  cleanup()
  localStorage.removeItem(STORAGE_KEY)
})

it('records an open under the page own handle, and shows it on return', async () => {
  const settled = getBrowserWorkspaceId()
  const store = new LocalStoreDouble()
  await store.save({
    documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
    workspaceId: settled,
    path: 'roadmap',
    name: 'roadmap',
    updatedAt: '2026-09-01T00:00:00Z',
    kind: 'spatial',
  })
  await new IdbDocumentIndex().createWorkspace({ workspaceId: settled, segment: 'default' })

  const page = (
    <MemoryRouter initialEntries={['/']}>
      <BrowserIndexPage
        index={store.index}
        loro={store.loro}
        pointer={store.pointer}
        clock={store.clock}
        onOpenDocument={vi.fn()}
      />
    </MemoryRouter>
  )
  render(page, { container: document.body })
  const card = (await screen.findByTestId('card-title')).closest('button')
  if (card === null) throw new Error('no card')
  await userEvent.dblClick(card)

  // The record is what the page's handle produced. Asserted before the
  // remount, so a lane that never appears is told apart from an open that
  // was never recorded.
  await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull())

  // cleanup() rather than unmount(): rendering into `document.body` twice
  // reuses testing-library's cached root, and React refuses to update an
  // unmounted one. cleanup clears that registration too.
  cleanup()
  render(page, { container: document.body })

  const lane = await screen.findByTestId('recent-lane')
  await waitFor(() => expect(lane.textContent).toContain('roadmap'))
})
