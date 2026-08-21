/**
 * The three-pane document browser, in LOCAL mode.
 *
 * One browser for both modes: the daemon page has had the tree view since
 * #902; this pins that the local page offers the same one, backed by the
 * local source, with the same grid/tree toggle.
 */
import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { ensureLocalWorkspace } from '../lib/local-document-summary.js'
import { clearWhiteboardDb } from '../test-utils/browser-local-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'
import { BrowserLocalIndexPage } from './BrowserLocalIndexPage.js'

claimIsolatedWhiteboardDb('browserlocalindexpage-tree-view')

function renderPage() {
  const onOpenDocument = vi.fn()
  render(
    <MemoryRouter initialEntries={['/']}>
      <BrowserLocalIndexPage index={new IdbDocumentIndex()} onOpenDocument={onOpenDocument} />
    </MemoryRouter>,
    { container: document.body },
  )
  return onOpenDocument
}

describe('browser-local tree view', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })
  afterEach(cleanup)

  it('offers the grid/tree toggle and shows the three-pane browser', async () => {
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    await seedIdbDocument(index, { path: 'roadmap', name: 'Roadmap', kind: 'markdown' })

    renderPage()

    // The same toggle the daemon page carries — one browser, both modes.
    const treeButton = await screen.findByRole('button', { name: 'Tree view' })
    fireEvent.click(treeButton)

    // The panel's search box is the tree view's distinctive chrome.
    await screen.findByLabelText('Search documents')
    // And the seeded document is reachable in it.
    await waitFor(() => {
      expect(screen.getAllByText('Roadmap').length).toBeGreaterThan(0)
    })
  })

  it('opens a document from the tree view through the same navigation', async () => {
    const index = new IdbDocumentIndex()
    await ensureLocalWorkspace(index)
    await seedIdbDocument(index, { path: 'roadmap', name: 'Roadmap', kind: 'markdown' })

    const onOpenDocument = renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Tree view' }))
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
