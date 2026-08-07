/**
 * A stale /local/:id deep link (bookmark to a deleted canvas) must not
 * dead-end: the page falls back to the default canvas, the URL is
 * replaced with the real id, and no degraded screen hides the editor.
 * Before this slice the URL→canvas effect switched to the missing id and
 * parked the page on "The canvas could not be switched." with no editor.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../lib/browser-local-store.js'
import type { LoroLoadResult } from '../lib/loro-store.js'
import type { LoroStoreLike } from './use-browser-local-canvas-controller.js'

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

vi.mock('../lib/browser-local-backend.js', () => ({
  BrowserLocalBackend: class {
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

const { BrowserLocalCanvasPage } = await import('./BrowserLocalCanvasPage.js')

afterEach(cleanup)

describe('stale /local/:id deep link', () => {
  it('falls back to the default canvas and replaces the URL', async () => {
    const store = new MemoryStore()
    await store.setDefaultCanvasId('real-1')
    await store.save({
      id: 'real-1',
      name: 'Real canvas',
      updatedAt: '2026-05-24T00:00:00.000Z',
      kind: 'spatial' as const,
    })

    const router = createMemoryRouter(
      [
        {
          path: '/local/:canvasId?',
          element: (
            <BrowserLocalCanvasPage
              store={store}
              loro={new FakeLoroStore()}
              initialCanvasId="gone-123"
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
      expect(router.state.location.pathname).toBe('/local/real-1')
    })
    // No degraded dead-end screen.
    expect(screen.queryByText('The canvas could not be switched.')).toBeNull()
  })
})
