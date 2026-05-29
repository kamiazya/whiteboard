import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import IndexPage from './IndexPage.js'

describe('IndexPage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders canvases as a flat list and never names the workspace', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString()
      if (url === '/api/workspaces') {
        return new Response(
          JSON.stringify({
            workspaces: [{ workspaceId: 'ws_1' }],
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
        return new Response(
          JSON.stringify({ workspace: 'Main workspace', canvases: { 'canvas-a': 'Login flow' } }),
          { status: 200 },
        )
      }
      if (url === '/api/runtime/storage') {
        return new Response(
          JSON.stringify({
            totalBytes: 0,
            fileCount: 0,
            byCategory: {
              blobs: { bytes: 0, files: 0 },
              versions: { bytes: 0, files: 0 },
              files: { bytes: 0, files: 0 },
              libraries: { bytes: 0, files: 0 },
              db: { bytes: 0, files: 0 },
              other: { bytes: 0, files: 0 },
            },
          }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container } = render(
      <MemoryRouter>
        <IndexPage />
      </MemoryRouter>,
    )

    // The canonical API trio drives the page even though the workspace name
    // never reaches the DOM in OSS Local mode.
    await waitFor(() => {
      expect(screen.getByText('Login flow')).toBeTruthy()
    })
    // apiFetch attaches a Headers object even without a token so OTel
    // traceparent injection has somewhere to live; assert URL only.
    const calledUrls = fetchMock.mock.calls.map((c: unknown[]) => c[0])
    expect(calledUrls).toContain('/api/workspaces')
    expect(calledUrls).toContain('/api/workspaces/ws_1/canvases')
    expect(calledUrls).toContain('/api/workspaces/ws_1/names')

    // Workspace identity is internal-only.
    expect(container.textContent).not.toContain('Main workspace')
    expect(container.textContent).not.toContain('Untitled workspace')
    expect(container.textContent).not.toContain('ws_1')
  })
})
