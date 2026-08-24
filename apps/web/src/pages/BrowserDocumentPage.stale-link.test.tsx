/**
 * A stale /local/:path deep link (bookmark to a deleted document) must not
 * dead-end: the page falls back to the default document, the URL is replaced
 * with the real path, and no degraded screen hides the editor. Two entry
 * points reach it and they are different code — the initial mount goes
 * through the controller's store-backed load, a MID-SESSION history
 * navigation goes through the page's own URL→document effect.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_WORKSPACE_ID } from '../lib/local-document-summary.js'
import type { LoroLoadResult } from '../lib/loro-store.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import type { LoroStoreLike } from './use-browser-document-controller.js'

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
    getFile() {
      return Promise.resolve(null)
    }
    putFile() {
      return Promise.resolve()
    }
    sendClientReady() {}
    sendExportResponse() {}
  },
}))

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

afterEach(cleanup)

describe('stale /local/:path deep link', () => {
  it('falls back to the default canvas and replaces the URL', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('005AFMSY38DJQW16BGNTZ49EKR')
    await store.save({
      documentId: '005AFMSY38DJQW16BGNTZ49EKR',
      workspaceId: BROWSER_WORKSPACE_ID,
      // Deliberately not the id: the fallback below has to be reached by PATH,
      // and an id-shaped path could not tell the two apart.
      path: 'real-canvas',
      name: 'Real canvas',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'spatial' as const,
    })

    const router = createMemoryRouter(
      [
        {
          path: '/local/*',
          element: (
            <BrowserDocumentPage
              store={store.index}
              pointer={store.pointer}
              clock={store.clock}
              loro={new FakeLoroStore()}
              initialPath="gone-123"
            />
          ),
        },
      ],
      { initialEntries: ['/local/gone-123'] },
    )
    await act(async () => {
      render(<RouterProvider router={router} />)
    })

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Real canvas')
    })
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/local/real-canvas')
    })
    // No degraded dead-end screen.
    expect(screen.queryByText('The canvas could not be switched.')).toBeNull()
  })

  it('repairs the address bar when a mid-session navigation names a path this workspace does not have', async () => {
    // The mounted page never remounts across /local/:path changes (see
    // App.tsx's routing comment), so the effect below is the ONLY thing that
    // can answer a Back onto a document that has since been deleted. It
    // resolves the requested path against the in-memory list, and a path that
    // is not in it used to make the effect return before reaching its own
    // documented repair — leaving the address bar naming nothing.
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('005AFMSY38DJQW16BGNTZ49EKR')
    await store.save({
      documentId: '005AFMSY38DJQW16BGNTZ49EKR',
      workspaceId: BROWSER_WORKSPACE_ID,
      path: 'real-canvas',
      name: 'Real canvas',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'spatial' as const,
    })

    const router = createMemoryRouter(
      [
        {
          path: '/local/*',
          element: (
            <BrowserDocumentPage
              store={store.index}
              pointer={store.pointer}
              clock={store.clock}
              loro={new FakeLoroStore()}
              initialPath="real-canvas"
            />
          ),
        },
      ],
      { initialEntries: ['/local/real-canvas'] },
    )
    await act(async () => {
      render(<RouterProvider router={router} />)
    })
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Real canvas')
    })

    await act(async () => {
      await router.navigate('/local/gone-123')
    })

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/local/real-canvas')
    })
    // The loaded document is untouched — a dead link costs the address bar, not
    // the editor.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Real canvas')
  })

  it('does not repair a path it cannot judge yet, while the document list is still loading', async () => {
    // `documents` starts empty and fills asynchronously, so during that window
    // "not in the list" means "not known yet", not "does not exist". Repairing
    // there would overwrite a navigation to a perfectly valid document with
    // the current path, and the list arriving later cannot undo it.
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId('005AFMSY38DJQW16BGNTZ49EKR')
    await store.save({
      documentId: '005AFMSY38DJQW16BGNTZ49EKR',
      workspaceId: BROWSER_WORKSPACE_ID,
      path: 'real-canvas',
      name: 'Real canvas',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'spatial' as const,
    })
    await store.save({
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
      workspaceId: BROWSER_WORKSPACE_ID,
      path: 'other-canvas',
      name: 'Other canvas',
      updatedAt: '2026-05-25T00:00:00.000Z',
      kind: 'spatial' as const,
    })

    // Held open so the navigation below lands inside the enumeration window.
    // The page's own list effect is the FIRST call — holding it still lets the
    // document load, because the controller resolves `initialPath` without
    // going through here. An earlier version held the second call on the
    // belief that the first was the controller's; nothing was suspended that
    // mattered, and the test spent months exercising the fast path twice.
    let releaseList: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      releaseList = resolve
    })
    // Held at the INDEX, which is what the page's listing actually reads.
    // The double's own `listDocuments` is not on that path any more, so
    // suspending it suspended nothing and the test covered the fast case
    // twice.
    const listDocuments = store.index.listDocuments.bind(store.index)
    let calls = 0
    store.index.listDocuments = async (input) => {
      calls += 1
      if (calls === 1) await held
      return listDocuments(input)
    }

    const router = createMemoryRouter(
      [
        {
          path: '/local/*',
          element: (
            <BrowserDocumentPage
              store={store.index}
              pointer={store.pointer}
              clock={store.clock}
              loro={new FakeLoroStore()}
              initialPath="real-canvas"
            />
          ),
        },
      ],
      { initialEntries: ['/local/real-canvas'] },
    )
    await act(async () => {
      render(<RouterProvider router={router} />)
    })
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Real canvas')
    })

    await act(async () => {
      await router.navigate('/local/other-canvas')
    })
    expect(router.state.location.pathname).toBe('/local/other-canvas')
    // The scaffold is IN the window, asserted rather than assumed. The page
    // still shows the document it loaded, which is what "the list has not
    // arrived" looks like from here — `switcherOptions` holds that document
    // alone, so `other-canvas` resolves to nothing and the branch under test
    // is the one that must not repair. Without this line the test passed for
    // months while never entering the window at all.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Real canvas')

    releaseList?.()
    await act(async () => {
      await Promise.resolve()
    })
    expect(router.state.location.pathname).toBe('/local/other-canvas')
  })
})
