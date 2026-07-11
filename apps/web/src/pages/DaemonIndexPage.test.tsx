import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonIndexPage } from './DaemonIndexPage.js'

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface MockRoutes {
  workspaces: Array<{ workspaceId: string }>
  canvasesByWorkspace: Record<string, Array<{ slug: string; updatedAt: string }>>
  namesByWorkspace?: Record<
    string,
    { workspace?: string; canvases: Record<string, string>; pinned: string[] } | 'fail'
  >
  onCreateCanvas?: (workspaceId: string, slug: string) => void
}

function installFetchMock(routes: MockRoutes) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/api/workspaces') && (!init || init.method === undefined)) {
      return Promise.resolve(jsonResponse({ workspaces: routes.workspaces }))
    }
    const canvasesMatch = url.match(/\/api\/workspaces\/([^/]+)\/canvases$/)
    if (canvasesMatch && (!init || init.method === undefined)) {
      const workspaceId = decodeURIComponent(canvasesMatch[1])
      const canvases = routes.canvasesByWorkspace[workspaceId]
      if (!canvases) return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
      return Promise.resolve(jsonResponse({ canvases }))
    }
    if (canvasesMatch && init?.method === 'POST') {
      const workspaceId = decodeURIComponent(canvasesMatch[1])
      const body = JSON.parse(String(init.body)) as { slug: string }
      routes.onCreateCanvas?.(workspaceId, body.slug)
      return Promise.resolve(jsonResponse({ slug: body.slug }))
    }
    const namesMatch = url.match(/\/api\/workspaces\/([^/]+)\/names$/)
    if (namesMatch) {
      const workspaceId = decodeURIComponent(namesMatch[1])
      const names = routes.namesByWorkspace?.[workspaceId]
      if (names === 'fail' || !names) {
        return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
      }
      return Promise.resolve(jsonResponse(names))
    }
    return Promise.resolve(jsonResponse({}, 404))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('DaemonIndexPage', () => {
  it('renders one card per canvas of the selected workspace with display name and relative updatedAt', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      canvasesByWorkspace: {
        'ws-a': [{ slug: 'alpha', updatedAt: new Date().toISOString() }],
        'ws-b': [{ slug: 'beta', updatedAt: new Date().toISOString() }],
      },
      namesByWorkspace: {
        'ws-a': { canvases: { alpha: 'Alpha Board' }, pinned: [] },
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)

    expect(await screen.findByText('Alpha Board')).toBeTruthy()
    expect(screen.queryByText('beta')).toBeNull()
  })

  it('switching the workspace selector replaces the visible cards', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      canvasesByWorkspace: {
        'ws-a': [{ slug: 'alpha', updatedAt: new Date().toISOString() }],
        'ws-b': [{ slug: 'beta', updatedAt: new Date().toISOString() }],
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)
    expect(await screen.findByText('alpha')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'ws-b' } })

    expect(await screen.findByText('beta')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
  })

  it('sorts pinned canvases before unpinned, and unpinned by updatedAt desc', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      canvasesByWorkspace: {
        'ws-a': [
          { slug: 'old', updatedAt: '2020-01-01T00:00:00Z' },
          { slug: 'new', updatedAt: '2026-01-01T00:00:00Z' },
          { slug: 'pinned-one', updatedAt: '2019-01-01T00:00:00Z' },
        ],
      },
      namesByWorkspace: {
        'ws-a': { canvases: {}, pinned: ['pinned-one'] },
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)
    await screen.findByText('pinned-one')

    const cards = screen.getAllByTestId('daemon-index-canvas-card')
    const slugs = cards.map((c) => within(c).getByTestId('canvas-slug').textContent)
    expect(slugs).toEqual(['pinned-one', 'new', 'old'])
  })

  it('filters cards by search input matching slug or display name', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      canvasesByWorkspace: {
        'ws-a': [
          { slug: 'alpha', updatedAt: new Date().toISOString() },
          { slug: 'beta', updatedAt: new Date().toISOString() },
        ],
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)
    await screen.findByText('alpha')

    fireEvent.change(screen.getByLabelText('Search canvases'), { target: { value: 'bet' } })

    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByText('beta')).toBeTruthy()
  })

  it('degrades gracefully to unpinned/slug-only when the names fetch fails', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      canvasesByWorkspace: {
        'ws-a': [{ slug: 'alpha', updatedAt: new Date().toISOString() }],
      },
      namesByWorkspace: { 'ws-a': 'fail' },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)
    expect(await screen.findByText('alpha')).toBeTruthy()
  })

  it('shows an alert (not a blank page) when listCanvases fails for the selected workspace', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      canvasesByWorkspace: {},
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('shows an alert when the initial workspace list fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ message: 'boom' }, 500))),
    )

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)

    expect((await screen.findByRole('alert')).textContent).toBe('Failed to load workspaces.')
  })

  it('does not apply a slower, stale workspace response after switching to a newer workspace', async () => {
    let resolveA: ((res: Response) => void) | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(
          jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }] }),
        )
      }
      if (url.endsWith('/api/workspaces/ws-a/canvases')) {
        return new Promise<Response>((resolve) => {
          resolveA = resolve
        })
      }
      if (url.endsWith('/api/workspaces/ws-b/canvases')) {
        return Promise.resolve(
          jsonResponse({ canvases: [{ slug: 'beta', updatedAt: new Date().toISOString() }] }),
        )
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)

    await waitFor(() => expect(screen.getByLabelText('Workspace')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'ws-b' } })
    expect(await screen.findByText('beta')).toBeTruthy()

    resolveA?.(jsonResponse({ canvases: [{ slug: 'alpha', updatedAt: new Date().toISOString() }] }))

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByText('beta')).toBeTruthy()
  })

  it('calls onOpenCanvas with the card identity on click', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      canvasesByWorkspace: {
        'ws-a': [{ slug: 'alpha', updatedAt: new Date().toISOString() }],
      },
    })
    const onOpenCanvas = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={onOpenCanvas} />)
    const card = await screen.findByTestId('daemon-index-canvas-card')
    fireEvent.click(card)

    expect(onOpenCanvas).toHaveBeenCalledExactlyOnceWith('ws-a', 'alpha')
  })

  it('creates a canvas via New canvas and opens it', async () => {
    const created: Array<[string, string]> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      canvasesByWorkspace: { 'ws-a': [] },
      onCreateCanvas: (workspaceId, slug) => created.push([workspaceId, slug]),
    })
    const onOpenCanvas = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={onOpenCanvas} />)
    await waitFor(() => expect(screen.getByLabelText('New canvas name')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('New canvas name'), { target: { value: 'fresh' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create canvas' }))

    await waitFor(() => expect(onOpenCanvas).toHaveBeenCalledWith('ws-a', 'fresh'))
    expect(created).toEqual([['ws-a', 'fresh']])
  })

  it('shows an alert when create canvas fails', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }] }))
      }
      if (url.endsWith('/api/workspaces/ws-a/canvases') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ message: 'boom' }, 500))
      }
      if (url.endsWith('/api/workspaces/ws-a/canvases')) {
        return Promise.resolve(jsonResponse({ canvases: [] }))
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)
    const onOpenCanvas = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={onOpenCanvas} />)
    await waitFor(() => expect(screen.getByLabelText('New canvas name')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('New canvas name'), { target: { value: 'fresh' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create canvas' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Failed to create canvas.')
    expect(onOpenCanvas).not.toHaveBeenCalled()
  })

  it('mounts StorageReportCard when the Storage tab is selected', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      canvasesByWorkspace: { 'ws-a': [{ slug: 'alpha', updatedAt: new Date().toISOString() }] },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)
    await screen.findByText('alpha')

    fireEvent.click(screen.getByRole('tab', { name: 'Storage' }))

    expect(await screen.findByText('Storage usage')).toBeTruthy()
    expect(screen.queryByTestId('daemon-index-canvas-card')).toBeNull()
  })
})
