// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getBrowserWorkspaceId,
  setBrowserWorkspaceIdForTests,
} from '../lib/browser-workspace-id.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import { BrowserIndexPage } from './BrowserIndexPage.js'

// A workspace switch is an in-SPA route change (ADR-0019), so this page stays
// mounted across one — and the CARDS come from WorkspaceFilesPanel, not from
// this page's own `snapshots` (which only decides onboarding-vs-panel). The
// panel detects a switch by its SOURCE IDENTITY changing, which is what the
// daemon page's `filesSource` memo is keyed on. The browser page's was keyed
// on [index, loro, clock] — none of which move when the workspace does — so
// the panel kept listing the workspace the person had just left, under an
// address naming the one they went to.
//
// The page-level test in BrowserIndexPage.test.tsx counts `listDocuments`
// CALLS, which this page's own effect satisfies on its own; only an assertion
// on the rendered cards can see this.

afterEach(cleanup)

const OTHER_WORKSPACE = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

function renderPage(store: LocalStoreDouble) {
  const onOpenDocument = vi.fn()
  render(
    <MemoryRouter initialEntries={['/']}>
      <BrowserIndexPage
        index={store.index}
        loro={store.loro}
        pointer={store.pointer}
        clock={store.clock}
        onOpenDocument={onOpenDocument}
      />
    </MemoryRouter>,
    { container: document.body },
  )
  return onOpenDocument
}

const titles = () => screen.getAllByTestId('card-title').map((el) => el.textContent)

describe('the card list follows a workspace switch', () => {
  it('lists the workspace it switched TO, and nothing from the one it left', async () => {
    const settled = getBrowserWorkspaceId()
    const store = new LocalStoreDouble()
    await store.save({
      documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
      workspaceId: settled,
      path: 'left-behind',
      name: 'Left behind',
      updatedAt: '2026-09-01T00:00:00Z',
      kind: 'spatial',
    })
    await store.index.createWorkspace({ workspaceId: OTHER_WORKSPACE })
    store.index.seed({
      workspaceId: OTHER_WORKSPACE,
      documentId: '0Z258BEHMQTX0369CFJNRVY147',
      path: 'arrived-at',
      name: 'Arrived at',
      kind: 'markdown',
    })

    try {
      renderPage(store)
      await waitFor(() => expect(titles()).toContain('Left behind'))

      await act(async () => {
        setBrowserWorkspaceIdForTests(OTHER_WORKSPACE, 'second')
      })

      await waitFor(() => expect(titles()).toContain('Arrived at'))
      expect(titles()).not.toContain('Left behind')
    } finally {
      setBrowserWorkspaceIdForTests(settled)
    }
  })

  it('search results stop naming the workspace that was left', async () => {
    // The panel resets RESULTS on a switch and deliberately keeps the typed
    // query (it re-runs against the new workspace). What must not survive is
    // a row naming a document that is not here — paths and names collide
    // across workspaces, and the row is clickable.
    const settled = getBrowserWorkspaceId()
    const store = new LocalStoreDouble()
    await store.save({
      documentId: '0CFJNRVY147ADGKPSWZ258BEHM',
      workspaceId: settled,
      path: 'left-behind',
      name: 'Left behind',
      updatedAt: '2026-09-01T00:00:00Z',
      kind: 'spatial',
    })
    await store.index.createWorkspace({ workspaceId: OTHER_WORKSPACE })
    store.index.seed({
      workspaceId: OTHER_WORKSPACE,
      documentId: '0Z258BEHMQTX0369CFJNRVY147',
      path: 'arrived-at',
      name: 'Arrived at',
      kind: 'markdown',
    })

    try {
      renderPage(store)
      await waitFor(() => expect(titles()).toContain('Left behind'))
      fireEvent.change(await screen.findByRole('searchbox', { name: 'Search documents' }), {
        target: { value: 'e' },
      })
      const results = await screen.findByTestId('search-results')
      await waitFor(() => expect(results.textContent).toContain('Left behind'))

      await act(async () => {
        setBrowserWorkspaceIdForTests(OTHER_WORKSPACE, 'second')
      })

      await waitFor(() => {
        expect(document.body.textContent).not.toContain('Left behind')
      })
    } finally {
      setBrowserWorkspaceIdForTests(settled)
    }
  })
})
