/**
 * "Back to documents" from a browser-kept document lands in the folder the
 * document sat in.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import type { LoroLoadResult } from '../lib/loro-store.js'
import { BrowserStoreDouble } from '../test-utils/browser-store-fixture.js'
import {
  latestEditorProps,
  resetCapturedEditorProps,
} from '../test-utils/capturing-spatial-editor.js'
import type { LoroStoreLike } from './use-browser-document-controller.js'

const MAIN = '005AFMSY38DJQW16BGNTZ49EKR'

class FakeLoroStore implements LoroStoreLike {
  private byId = new Map<string, Uint8Array>()
  async save(id: string, bytes: Uint8Array): Promise<void> {
    this.byId.set(id, bytes)
  }
  createEmptySnapshot(): Uint8Array {
    return new Uint8Array([1, 2, 3])
  }
  async load(id: string): Promise<LoroLoadResult> {
    const bytes = this.byId.get(id)
    if (bytes === undefined) return { kind: 'not-found' }
    return { kind: 'ok', snapshot: bytes }
  }
}

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

describe('BrowserDocumentPage Back', () => {
  afterEach(cleanup)

  it('opens the folder the document sat in', async () => {
    resetCapturedEditorProps()
    const store = new BrowserStoreDouble()
    await store.setDefaultDocumentId(MAIN)
    await store.save({
      documentId: MAIN,
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes/main',
      name: 'Main',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'spatial' as const,
    })
    const router = createMemoryRouter(
      [
        {
          path: '/w/*',
          element: (
            <BrowserDocumentPage
              store={store.index}
              pointer={store.pointer}
              clock={store.clock}
              loro={new FakeLoroStore()}
              initialPath="notes/main"
            />
          ),
        },
      ],
      { initialEntries: ['/w/me/default/d/notes/main'] },
    )
    await act(async () => {
      render(<RouterProvider router={router} />)
    })
    await waitFor(() => expect(latestEditorProps()).toBeDefined())
    fireEvent.click(await screen.findByRole('button', { name: 'Back to documents' }))
    await waitFor(() => expect(router.state.location.search).toBe('?folder=notes'))
  })
})
