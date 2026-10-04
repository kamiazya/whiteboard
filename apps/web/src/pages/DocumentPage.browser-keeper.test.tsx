/**
 * The document-page contract against the BROWSER keeper: documents seeded
 * into the in-memory index double, the sync backend faked, the page mounted
 * on the real route grammar so "opened another document" is a route change.
 */
import { act, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { expect, vi } from 'vitest'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { BrowserStoreDouble, InMemoryLoroStore } from '../test-utils/browser-store-fixture.js'
import {
  type ContractDocument,
  type DocumentPageFixture,
  describeDocumentPageContract,
} from '../test-utils/document-page.contract.js'

vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  const { CapturingSpatialEditor } = await import('../test-utils/capturing-spatial-editor.js')
  return { ...actual, SpatialEditor: CapturingSpatialEditor }
})

vi.mock('../lib/browser-backend.js', async () => {
  const { FakeBrowserBackend } = await import('../test-utils/fake-browser-backend.js')
  return { BrowserBackend: FakeBrowserBackend }
})

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

let router: ReturnType<typeof createMemoryRouter> | null = null
let store: BrowserStoreDouble | null = null

const browserFixture: DocumentPageFixture = {
  keeper: 'browser',
  async mount(documents: readonly ContractDocument[]) {
    const [open] = documents
    if (open === undefined) throw new Error('mount needs at least one document')
    const seeded = new BrowserStoreDouble()
    store = seeded
    await seeded.setDefaultDocumentId(open.id)
    for (const doc of documents) {
      await seeded.save({
        documentId: doc.id,
        workspaceId: getBrowserWorkspaceId(),
        path: doc.path,
        name: doc.name,
        updatedAt: '2026-05-24T00:00:00.000Z',
        kind: doc.kind,
      })
    }
    router = createMemoryRouter(
      [
        {
          path: '/w/:workspace/d/*',
          element: (
            <BrowserDocumentPage
              store={seeded.index}
              pointer={seeded.pointer}
              clock={seeded.clock}
              loro={new InMemoryLoroStore()}
              initialPath={open.path}
            />
          ),
        },
      ],
      { initialEntries: [`/w/default/d/${open.path}`] },
    )
    const mounted = router
    await act(async () => {
      rtlRender(<RouterProvider router={mounted} />)
    })
    await waitFor(() => expect(screen.getByTestId('stub-spatial-editor')).toBeTruthy())
  },
  // The browser's index carries a display name, and the picker shows it.
  labelOf: (doc) => doc.name,
  async expectOpened(path) {
    await waitFor(() => {
      expect(router?.state.location.pathname).toBe(`/w/default/d/${path}`)
    })
  },
  failNextDelete() {
    const index = store?.index
    if (index === undefined) throw new Error('failNextDelete before mount')
    const real = index.deleteDocument.bind(index)
    index.deleteDocument = async () => {
      index.deleteDocument = real
      throw new Error('simulated IndexedDB refusal')
    }
  },
}

describeDocumentPageContract(browserFixture)
