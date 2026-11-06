/**
 * A document opened by address — no card click — still enters the Recent lane
 * and takes the index's digest as its seen baseline, so it carries no
 * "changed" dot when the person goes back to the list.
 */
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserMemoryScope } from '../components/workspace-files/use-device-memory.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { readRecentIds } from '../lib/recent-documents.js'
import { readSeenDigest } from '../lib/seen-documents.js'
import { BrowserStoreDouble } from '../test-utils/browser-store-fixture.js'
import {
  latestEditorProps,
  resetCapturedEditorProps,
} from '../test-utils/capturing-spatial-editor.js'

const MAIN = '005AFMSY38DJQW16BGNTZ49EKR'

vi.mock('../lib/browser-backend.js', () => ({
  BrowserBackend: class {
    connect(handlers: { onConnected: () => void }) {
      handlers.onConnected()
    }
    disconnect() {}
    pushLocalUpdate() {
      return Promise.resolve()
    }
    sendClientReady() {}
  },
}))

vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  const { CapturingSpatialEditor } = await import('../test-utils/capturing-spatial-editor.js')
  return { ...actual, SpatialEditor: CapturingSpatialEditor }
})

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

const LISTED = 'digest-in-index'

describe('BrowserDocumentPage remembers the open', () => {
  let store: BrowserStoreDouble

  beforeEach(async () => {
    window.localStorage.clear()
    resetCapturedEditorProps()
    store = new BrowserStoreDouble()
    await store.setDefaultDocumentId(MAIN)
    await store.save({
      documentId: MAIN,
      workspaceId: getBrowserWorkspaceId(),
      path: 'main',
      name: 'Main',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'spatial' as const,
    })
    const list = store.index.listDocuments.bind(store.index)
    vi.spyOn(store.index, 'listDocuments').mockImplementation(async (query) =>
      (await list(query)).map((entry) => ({ ...entry, contentDigest: LISTED })),
    )
  })
  afterEach(cleanup)

  it('records Recent and the listing digest for a document opened by address', async () => {
    const router = createMemoryRouter(
      [
        {
          path: '/w/*',
          element: (
            <BrowserDocumentPage
              store={store.index}
              pointer={store.pointer}
              clock={store.clock}
              initialPath="main"
            />
          ),
        },
      ],
      { initialEntries: ['/w/me/default/d/main'] },
    )
    await act(async () => {
      render(<RouterProvider router={router} />)
    })
    await waitFor(() => expect(latestEditorProps()).toBeDefined())
    const scope = browserMemoryScope({ workspaceId: getBrowserWorkspaceId() })
    await waitFor(() => expect(readRecentIds(scope)).toContain(MAIN))
    await waitFor(() => expect(readSeenDigest(scope, MAIN)).toBe(LISTED))
  })
})
