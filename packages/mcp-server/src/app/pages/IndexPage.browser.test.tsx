import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import '../index.css'
import IndexPage from './IndexPage.js'

type FetchArgs = [RequestInfo | URL, RequestInit?]

beforeEach(() => {
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url === '/api/workspaces') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            workspaces: [{ workspaceId: 'ws_1', daemonAlive: true }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }
    if (url === '/api/workspaces/ws_1/canvases') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            canvases: [{ slug: 'canvas-a', updatedAt: '2026-04-25T00:00:00.000Z' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }
    if (url === '/api/workspaces/ws_1/names') {
      return Promise.resolve(
        new Response(
          JSON.stringify({ workspace: 'Main workspace', canvases: {} }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

describe('IndexPage browser mode', () => {
  it('loads workspaces from the canonical API and renders the workspace card', async () => {
    render(
      <MemoryRouter>
        <div className="min-h-screen w-[1100px] bg-background p-6">
          <IndexPage />
        </div>
      </MemoryRouter>,
    )

    await expect.element(page.getByText('Main workspace')).toBeInTheDocument()
    await waitFor(() => {
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
      expect(fetchMock).toHaveBeenCalledWith('/api/workspaces', undefined)
      expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws_1/canvases', undefined)
      expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws_1/names', undefined)
    })
    await expect.element(page.getByRole('link', { name: /canvas-a/i })).toBeInTheDocument()
  })
})
