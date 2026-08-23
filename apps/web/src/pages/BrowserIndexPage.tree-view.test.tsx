/**
 * The three-pane document browser, in LOCAL mode, over the REAL IndexedDB
 * stores (fake-indexeddb): the injected-double page tests cannot see a
 * wiring split between the page's stores and the panel's source, and this
 * file exists for exactly that seam.
 */
import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { ensureLocalWorkspace } from '../lib/local-document-summary.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'
import { BrowserIndexPage } from './BrowserIndexPage.js'

claimIsolatedWhiteboardDb('browserindexpage-tree-view')

function renderPage() {
  const onOpenDocument = vi.fn()
  render(
    <MemoryRouter initialEntries={['/']}>
      <BrowserIndexPage index={new IdbDocumentIndex()} onOpenDocument={onOpenDocument} />
    </MemoryRouter>,
    { container: document.body },
  )
  return onOpenDocument
}

describe('document kept in this browser browser (real stores)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })
  afterEach(cleanup)

  it('lands on the three-pane browser, no toggle in between', async () => {
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    await seedIdbDocument(index, { path: 'roadmap', name: 'Roadmap', kind: 'markdown' })

    renderPage()

    // The panel's search box is the browser's distinctive chrome.
    await screen.findByLabelText('Search documents')
    // And the seeded document is reachable in it.
    await waitFor(() => {
      expect(screen.getAllByText('Roadmap').length).toBeGreaterThan(0)
    })
  })

  it('opens a document from the browser through the same navigation', async () => {
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    await seedIdbDocument(index, { path: 'roadmap', name: 'Roadmap', kind: 'markdown' })

    const onOpenDocument = renderPage()
    fireEvent.click((await screen.findAllByText('Roadmap'))[0] as HTMLElement)

    // Selecting shows the preview; its open affordance drives navigation.
    // Several affordances say "open"; the preview pane's is the one under
    // test, and its label names the document.
    const opens = await screen.findAllByRole('button', { name: /open/i })
    fireEvent.click(opens[opens.length - 1] as HTMLElement)
    await waitFor(() => {
      expect(onOpenDocument).toHaveBeenCalledWith('roadmap')
    })
  })
})
