/**
 * Where a document page lands after Delete, and what a URL naming a document
 * that is gone shows. The answer is the workspace LIST in both cases — never
 * another document, and never a fresh empty canvas at the path that was just
 * deleted (which reads as the note turning into a canvas).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../components/workspace-top-bar/WorkspaceTopBar.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { BrowserStoreDouble } from '../test-utils/browser-store-fixture.js'
import { openDocumentOpsMenu } from '../test-utils/daemon-page-harness.js'

vi.mock('../lib/browser-backend.js', async () => {
  const { FakeBrowserBackend } = await import('../test-utils/fake-browser-backend.js')
  return { BrowserBackend: FakeBrowserBackend }
})

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')
const { BrowserIndexPage } = await import('./BrowserIndexPage.js')

afterEach(cleanup)

const snapshotAt = (documentId: string, path: string): DocumentSnapshot => ({
  documentId,
  workspaceId: getBrowserWorkspaceId(),
  path,
  name: path,
  updatedAt: '2026-05-24T00:00:00.000Z',
  kind: 'markdown' as const,
})

const FIRST = snapshotAt('069CFJNRVY147ADGKPSWZ258BE', 'notes/first')
const SECOND = snapshotAt('01ARZ3NDEKTSV4RRFFQ69G5FB0', 'second')

async function mount(store: BrowserStoreDouble, url: string, initialPath: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/w/:namespace/:segment/d/*',
        element: (
          <BrowserDocumentPage
            store={store.index}
            pointer={store.pointer}
            clock={store.clock}
            loro={store.loro}
            initialPath={initialPath}
          />
        ),
      },
      {
        path: '/w/:namespace/:segment',
        element: (
          <BrowserIndexPage
            index={store.index}
            pointer={store.pointer}
            clock={store.clock}
            loro={store.loro}
            onOpenDocument={() => {}}
          />
        ),
      },
    ],
    { initialEntries: [url] },
  )
  await act(async () => {
    render(<RouterProvider router={router} />, { container: document.body })
  })
  return router
}

async function deleteFromPage() {
  await openDocumentOpsMenu()
  fireEvent.pointerUp(await screen.findByRole('menuitem', { name: /^delete$/i }))
  const confirm = await screen.findByRole('button', { name: /^delete$/i })
  await act(async () => {
    confirm.click()
  })
}

describe('deleting from a browser-kept document page', () => {
  it('lands on the list of the folder the document was in when siblings remain', async () => {
    const store = new BrowserStoreDouble()
    await store.save(FIRST)
    await store.save(SECOND)
    await store.setDefaultDocumentId(FIRST.documentId)
    const router = await mount(store, '/w/me/default/d/notes/first', 'notes/first')
    await screen.findByRole('main')

    await deleteFromPage()

    await waitFor(() => expect(router.state.location.pathname).toBe('/w/me/default'))
    expect(new URLSearchParams(router.state.location.search).get('folder')).toBe('notes')
    expect(await store.index.listDocuments({ workspaceId: getBrowserWorkspaceId() })).toHaveLength(
      1,
    )
  })

  it('shows the first-run screen, not a new canvas, when it was the only document', async () => {
    const store = new BrowserStoreDouble()
    await store.save(SECOND)
    await store.setDefaultDocumentId(SECOND.documentId)
    const router = await mount(store, '/w/me/default/d/second', 'second')
    await screen.findByRole('main')

    await deleteFromPage()

    await screen.findByText('What will you make first?')
    expect(router.state.location.pathname).toBe('/w/me/default')
    expect(await store.index.listDocuments({ workspaceId: getBrowserWorkspaceId() })).toHaveLength(
      0,
    )
  })
})

describe('a URL naming a path that no longer exists', () => {
  it('shows the first-run screen, not an empty canvas at that path, in an empty workspace', async () => {
    const store = new BrowserStoreDouble()
    const router = await mount(store, '/w/me/default/d/untitled', 'untitled')

    await screen.findByText('What will you make first?')
    expect(router.state.location.pathname).toBe('/w/me/default')
    expect(await store.index.listDocuments({ workspaceId: getBrowserWorkspaceId() })).toHaveLength(
      0,
    )
  })
})
