import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import IndexPage from './IndexPage.js'

describe('IndexPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loads workspaces from the canonical API routes', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString()
      if (url === '/api/workspaces') {
        return new Response(
          JSON.stringify({
            workspaces: [{ workspaceId: 'ws_1', daemonAlive: true }],
          }),
          { status: 200 },
        )
      }
      if (url === '/api/workspaces/ws_1/canvases') {
        return new Response(
          JSON.stringify({
            canvases: [{ slug: 'canvas-a', updatedAt: '2026-04-25T00:00:00.000Z' }],
          }),
          { status: 200 },
        )
      }
      if (url === '/api/workspaces/ws_1/names') {
        return new Response(JSON.stringify({ workspace: 'Main workspace', canvases: {} }), {
          status: 200,
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MemoryRouter>
        <IndexPage />
      </MemoryRouter>,
    )

    await waitFor(() => {
      expect(screen.getByText('Main workspace')).toBeTruthy()
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces', undefined)
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws_1/canvases', undefined)
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces/ws_1/names', undefined)
  })
})
