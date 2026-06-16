import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import IndexPage from './IndexPage.js'

// Minimal fetch stub that covers the workspace/canvas/storage calls IndexPage
// makes on mount, plus a custom POST handler for NewCanvasDialog tests.
function makeDefaultFetch(
  postHandler?: (url: string) => Response | null,
): (input: string | URL) => Promise<Response> {
  return async (input: string | URL) => {
    const url = input.toString()
    if (typeof postHandler === 'function') {
      const override = postHandler(url)
      if (override) return override
    }
    if (url === '/api/workspaces') {
      return new Response(JSON.stringify({ workspaces: [{ workspaceId: 'ws_1' }] }), {
        status: 200,
      })
    }
    if (url === '/api/workspaces/ws_1/canvases') {
      return new Response(JSON.stringify({ canvases: [] }), { status: 200 })
    }
    if (url === '/api/workspaces/ws_1/names') {
      return new Response(JSON.stringify({ workspace: 'W', canvases: {}, pinned: [] }), {
        status: 200,
      })
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
  }
}

async function openNewCanvasDialog(): Promise<void> {
  // The page renders two "New canvas" affordances (the header button with
  // aria-label + the card button). Both open the same dialog — pick the first.
  await waitFor(() => {
    expect(screen.getAllByRole('button', { name: /new canvas/i }).length).toBeGreaterThan(0)
  })
  const btn = screen.getAllByRole('button', { name: /new canvas/i })[0]
  fireEvent.click(btn)
  await waitFor(() => {
    expect(document.getElementById('new-canvas-slug')).not.toBeNull()
  })
  const input = document.getElementById('new-canvas-slug') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'test-canvas' } })
}

async function submitDialog(): Promise<void> {
  const form = document.getElementById('new-canvas-slug')?.closest('form')
  if (!form) throw new Error('form not found')
  fireEvent.submit(form)
}

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

describe('IndexPage NewCanvasDialog error handling', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows a daemon-auth hint (not the raw status code) when canvas creation returns 401', async () => {
    const fetchMock = vi.fn(
      makeDefaultFetch((url) => {
        if (url.includes('/canvases') && url.includes('/ws_1/')) {
          // Only intercept POST — GET canvases list returns normally above
          return null
        }
        return null
      }),
    )
    // Override to intercept the POST
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (init?.method === 'POST' && url.includes('/canvases')) {
        return new Response(null, { status: 401 })
      }
      return makeDefaultFetch()(input)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MemoryRouter>
        <IndexPage />
      </MemoryRouter>,
    )

    await openNewCanvasDialog()
    await submitDialog()

    await waitFor(() => {
      // Must mention daemon/authentication — something actionable
      const errorEl = document.querySelector('.text-destructive')
      expect(errorEl).not.toBeNull()
      const text = errorEl?.textContent ?? ''
      // Should NOT be just the raw "(401)" pattern
      expect(text).not.toBe('Create failed (401).')
      // Should contain guidance about the daemon or authentication
      expect(text.toLowerCase()).toMatch(/daemon|auth|token|start/)
    })
  })

  it('shows the generic "Create failed (N)." pattern for non-401 errors like 500', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (init?.method === 'POST' && url.includes('/canvases')) {
        return new Response(null, { status: 500 })
      }
      return makeDefaultFetch()(input)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MemoryRouter>
        <IndexPage />
      </MemoryRouter>,
    )

    await openNewCanvasDialog()
    await submitDialog()

    await waitFor(() => {
      const errorEl = document.querySelector('.text-destructive')
      expect(errorEl).not.toBeNull()
      // For non-401, the generic message or Problem Details title is fine
      // The key thing is it does NOT show the daemon-auth hint
      const text = errorEl?.textContent ?? ''
      expect(text).toBeTruthy()
      // 500 should not trigger the 401-specific auth message
      expect(text.toLowerCase()).not.toMatch(/daemon.*auth|auth.*daemon/)
    })
  })

  it('shows the Problem Details title when the server returns 409 with a valid title', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (init?.method === 'POST' && url.includes('/canvases')) {
        return new Response(
          JSON.stringify({ title: 'Canvas slug already exists', type: 'about:blank' }),
          { status: 409, headers: { 'Content-Type': 'application/problem+json' } },
        )
      }
      return makeDefaultFetch()(input)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <MemoryRouter>
        <IndexPage />
      </MemoryRouter>,
    )

    await openNewCanvasDialog()
    await submitDialog()

    await waitFor(() => {
      const errorEl = document.querySelector('.text-destructive')
      expect(errorEl).not.toBeNull()
      // The Problem Details title must surface verbatim
      expect(errorEl?.textContent).toContain('Canvas slug already exists')
    })
  })
})
