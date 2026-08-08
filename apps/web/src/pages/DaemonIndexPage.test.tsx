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
  snapshotByCanvas?: Record<string, Uint8Array>
  onUpdateCanvas?: (workspaceId: string, slug: string, bytes: Uint8Array) => void
  onSetCanvasName?: (workspaceId: string, slug: string, name: string) => void
  /** When set, the canvases fetch resolves only after this promise settles. */
  delayCanvases?: Promise<void>
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
      const respond = () => jsonResponse({ canvases })
      if (routes.delayCanvases) return routes.delayCanvases.then(respond)
      return Promise.resolve(respond())
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
    const snapshotMatch = url.match(/\/api\/canvas\/([^/]+)\/([^/]+)\/snapshot$/)
    if (snapshotMatch) {
      const slug = decodeURIComponent(snapshotMatch[2])
      const bytes = routes.snapshotByCanvas?.[slug]
      if (!bytes) return Promise.resolve(jsonResponse({ title: 'Not found' }, 404))
      return Promise.resolve(
        new Response(bytes as BodyInit, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      )
    }
    const updateMatch = url.match(/\/api\/canvas\/([^/]+)\/([^/]+)\/update$/)
    if (updateMatch && init?.method === 'POST') {
      const workspaceId = decodeURIComponent(updateMatch[1])
      const slug = decodeURIComponent(updateMatch[2])
      routes.onUpdateCanvas?.(workspaceId, slug, new Uint8Array(init.body as ArrayBuffer))
      return Promise.resolve(jsonResponse({ ok: true }))
    }
    const canvasNameMatch = url.match(/\/api\/workspaces\/([^/]+)\/canvases\/([^/]+)\/name$/)
    if (canvasNameMatch && init?.method === 'PUT') {
      const workspaceId = decodeURIComponent(canvasNameMatch[1])
      const slug = decodeURIComponent(canvasNameMatch[2])
      const body = JSON.parse(String(init.body)) as { name: string }
      routes.onSetCanvasName?.(workspaceId, slug, body.name)
      const names = routes.namesByWorkspace?.[workspaceId]
      const canvases = names && names !== 'fail' ? names.canvases : {}
      return Promise.resolve(
        jsonResponse({ canvases: { ...canvases, [slug]: body.name }, pinned: [] }),
      )
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

  it('fades the loaded grid in for skeleton-to-content continuity', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      canvasesByWorkspace: {
        'ws-a': [{ slug: 'alpha', updatedAt: new Date().toISOString() }],
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)

    const card = await screen.findByTestId('daemon-index-canvas-card')
    const grid = card.parentElement as HTMLElement
    expect(grid.className).toMatch(/\banimate-in\b/)
    expect(grid.className).toMatch(/\bfade-in-0\b/)
  })

  it('honors initialWorkspaceId over the daemon-listed first workspace', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      canvasesByWorkspace: {
        'ws-a': [{ slug: 'alpha', updatedAt: new Date().toISOString() }],
        'ws-b': [{ slug: 'beta', updatedAt: new Date().toISOString() }],
      },
    })

    render(
      <DaemonIndexPage
        daemonBaseUrl={DAEMON_BASE_URL}
        initialWorkspaceId="ws-b"
        onOpenCanvas={vi.fn()}
      />,
    )

    expect(await screen.findByText('beta')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe('ws-b')
  })

  it('falls back to the first-listed workspace when initialWorkspaceId is not in the daemon list', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      canvasesByWorkspace: {
        'ws-a': [{ slug: 'alpha', updatedAt: new Date().toISOString() }],
        'ws-b': [{ slug: 'beta', updatedAt: new Date().toISOString() }],
      },
    })

    render(
      <DaemonIndexPage
        daemonBaseUrl={DAEMON_BASE_URL}
        initialWorkspaceId="stale-deleted-workspace"
        onOpenCanvas={vi.fn()}
      />,
    )

    expect(await screen.findByText('alpha')).toBeTruthy()
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

  it("clears the previous workspace's cards immediately on switch, before the new load resolves", async () => {
    // A stale card clicked in the switch window would pair the NEW workspace
    // id with the OLD workspace's slug — a mismatched identity.
    // Each pending call gets its own deferred + fresh Response (a Response
    // body is single-use, and the load may retry/refire).
    const waiters: Array<() => void> = []
    const releaseB = () => {
      for (const w of waiters.splice(0)) w()
    }
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(
          jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }] }),
        )
      }
      if (url.includes('/ws-a/canvases')) {
        return Promise.resolve(
          jsonResponse({ canvases: [{ slug: 'alpha', updatedAt: new Date().toISOString() }] }),
        )
      }
      if (url.includes('/ws-b/canvases')) {
        return new Promise<Response>((resolve) => {
          waiters.push(() =>
            resolve(
              jsonResponse({ canvases: [{ slug: 'beta', updatedAt: new Date().toISOString() }] }),
            ),
          )
        })
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)
    expect(await screen.findByText('alpha')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'ws-b' } })

    // ws-b's canvases request is still pending — the old grid must be gone NOW.
    expect(screen.queryByText('alpha')).toBeNull()

    releaseB()
    expect(await screen.findByText('beta')).toBeTruthy()
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

  it('duplicates a canvas via its card Duplicate action without opening it', async () => {
    const updates: Array<[string, string, Uint8Array]> = []
    const created: Array<[string, string]> = []
    const names: Array<[string, string, string]> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      canvasesByWorkspace: {
        'ws-a': [{ slug: 'alpha', updatedAt: new Date().toISOString() }],
      },
      namesByWorkspace: { 'ws-a': { canvases: { alpha: 'Alpha' }, pinned: [] } },
      snapshotByCanvas: { alpha: new Uint8Array([1, 2, 3]) },
      onCreateCanvas: (workspaceId, slug) => created.push([workspaceId, slug]),
      onUpdateCanvas: (workspaceId, slug, bytes) => updates.push([workspaceId, slug, bytes]),
      onSetCanvasName: (workspaceId, slug, name) => names.push([workspaceId, slug, name]),
    })
    const onOpenCanvas = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={onOpenCanvas} />)
    const duplicateBtn = await screen.findByRole('button', { name: /duplicate/i })
    fireEvent.click(duplicateBtn)

    await waitFor(() => {
      expect(created).toEqual([['ws-a', 'alpha-copy']])
    })
    expect(updates).toEqual([['ws-a', 'alpha-copy', new Uint8Array([1, 2, 3])]])
    expect(names).toEqual([['ws-a', 'alpha-copy', 'Alpha (copy)']])
    // Clicking the Duplicate action must not also open the source canvas.
    expect(onOpenCanvas).not.toHaveBeenCalled()
  })

  it('disables the card Duplicate button while in flight, and double-clicking produces exactly one copy', async () => {
    let resolveSnapshot: ((res: Response) => void) | undefined
    let snapshotCalls = 0
    const created: Array<[string, string]> = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces') && (!init || init.method === undefined)) {
        return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }] }))
      }
      if (url.endsWith('/api/workspaces/ws-a/canvases') && (!init || init.method === undefined)) {
        return Promise.resolve(
          jsonResponse({ canvases: [{ slug: 'alpha', updatedAt: new Date().toISOString() }] }),
        )
      }
      if (url.endsWith('/api/workspaces/ws-a/canvases') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { slug: string }
        created.push(['ws-a', body.slug])
        return Promise.resolve(jsonResponse({ slug: body.slug }))
      }
      if (url.endsWith('/api/workspaces/ws-a/names')) {
        return Promise.resolve(jsonResponse({ canvases: { alpha: 'Alpha' }, pinned: [] }))
      }
      if (url.endsWith('/api/canvas/ws-a/alpha/snapshot')) {
        snapshotCalls++
        return new Promise<Response>((resolve) => {
          resolveSnapshot = resolve
        })
      }
      if (/\/api\/canvas\/ws-a\/[^/]+\/update$/.test(url) && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (/\/api\/workspaces\/ws-a\/canvases\/[^/]+\/name$/.test(url) && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ canvases: { alpha: 'Alpha' }, pinned: [] }))
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)
    const duplicateBtn = (await screen.findByRole('button', {
      name: /duplicate/i,
    })) as HTMLButtonElement
    fireEvent.click(duplicateBtn)
    await waitFor(() => expect(duplicateBtn.disabled).toBe(true))

    // A second click while disabled must not start a second duplicate read.
    fireEvent.click(duplicateBtn)
    expect(snapshotCalls).toBe(1)

    resolveSnapshot?.(
      new Response(new Uint8Array([1, 2, 3]) as BodyInit, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    )
    await waitFor(() => expect(created).toEqual([['ws-a', 'alpha-copy']]))
    await waitFor(() => expect(duplicateBtn.disabled).toBe(false))
    vi.unstubAllGlobals()
  })

  it('shows an alert and re-enables the Duplicate button when duplicating fails', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      canvasesByWorkspace: {
        'ws-a': [{ slug: 'alpha', updatedAt: new Date().toISOString() }],
      },
      namesByWorkspace: { 'ws-a': { canvases: { alpha: 'Alpha' }, pinned: [] } },
      // No snapshotByCanvas entry for 'alpha' -> the mock 404s the snapshot read.
    })
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)
    const duplicateBtn = (await screen.findByRole('button', {
      name: /duplicate/i,
    })) as HTMLButtonElement
    fireEvent.click(duplicateBtn)

    expect((await screen.findByRole('alert')).textContent).toMatch(/not found/i)
    expect(duplicateBtn.disabled).toBe(false)
  })

  it('does not apply a stale duplicate completion to a workspace the user has since switched away from', async () => {
    let resolveSnapshot: ((res: Response) => void) | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces') && (!init || init.method === undefined)) {
        return Promise.resolve(
          jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }] }),
        )
      }
      if (url.endsWith('/api/workspaces/ws-a/canvases') && (!init || init.method === undefined)) {
        return Promise.resolve(
          jsonResponse({ canvases: [{ slug: 'alpha', updatedAt: new Date().toISOString() }] }),
        )
      }
      if (url.endsWith('/api/workspaces/ws-b/canvases') && (!init || init.method === undefined)) {
        return Promise.resolve(
          jsonResponse({ canvases: [{ slug: 'beta', updatedAt: new Date().toISOString() }] }),
        )
      }
      if (url.endsWith('/api/workspaces/ws-a/canvases') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { slug: string }
        return Promise.resolve(jsonResponse({ slug: body.slug }))
      }
      if (
        url.endsWith('/api/workspaces/ws-a/names') ||
        url.endsWith('/api/workspaces/ws-b/names')
      ) {
        return Promise.resolve(jsonResponse({ canvases: {}, pinned: [] }))
      }
      if (url.endsWith('/api/canvas/ws-a/alpha/snapshot')) {
        return new Promise<Response>((resolve) => {
          resolveSnapshot = resolve
        })
      }
      if (/\/api\/canvas\/ws-a\/[^/]+\/update$/.test(url) && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (/\/api\/workspaces\/ws-a\/canvases\/[^/]+\/name$/.test(url) && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ canvases: {}, pinned: [] }))
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)
    const duplicateBtn = await screen.findByRole('button', { name: /duplicate/i })
    fireEvent.click(duplicateBtn)

    // Switch workspaces while the duplicate (still reading alpha's snapshot) is in flight.
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'ws-b' } })
    expect(await screen.findByText('beta')).toBeTruthy()

    resolveSnapshot?.(
      new Response(new Uint8Array([1, 2, 3]) as BodyInit, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The completed duplicate belongs to ws-a; the visible grid must still be
    // ws-b's, untouched by ws-a's post-duplicate refresh.
    expect(screen.getByText('beta')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.queryByText('alpha-copy')).toBeNull()
    vi.unstubAllGlobals()
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

    expect((await screen.findByRole('alert')).textContent).toBe('Request failed (500).')
    expect(screen.queryByText(/boom/)).toBeNull()
    expect(onOpenCanvas).not.toHaveBeenCalled()
  })

  it('has no Storage tab — storage and pairing live in Settings (design refactor D2)', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      canvasesByWorkspace: { 'ws-a': [{ slug: 'alpha', updatedAt: new Date().toISOString() }] },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)
    await screen.findByText('alpha')

    // The top level is the canvas surface only: no tablist at all.
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Storage' })).toBeNull()

    // The operational surfaces open from Settings instead.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(await screen.findByText('Storage usage')).toBeTruthy()
    expect(screen.getByText('Paired web apps')).toBeTruthy()
    // The canvas grid stays mounted behind the dialog.
    expect(screen.getByTestId('daemon-index-canvas-card')).toBeTruthy()
  })

  it('hides the workspace selector when there is only one workspace (raw id demoted, D3)', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'dTMMrBP3c5ah8_SXTRVvC' }],
      canvasesByWorkspace: {
        dTMMrBP3c5ah8_SXTRVvC: [{ slug: 'alpha', updatedAt: new Date().toISOString() }],
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)
    await screen.findByText('alpha')

    // One workspace = nothing to choose; the raw id has no reason to be
    // page chrome. Multi-workspace daemons keep the selector.
    expect(screen.queryByLabelText('Workspace')).toBeNull()
  })

  it('labels the new-canvas input with a placeholder instead of floating unlabeled', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      canvasesByWorkspace: { 'ws-a': [{ slug: 'alpha', updatedAt: new Date().toISOString() }] },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)
    await screen.findByText('alpha')

    expect(screen.getByPlaceholderText('New canvas name…')).toBeTruthy()
  })

  it('shows a loading skeleton before the first load resolves, never a false empty state', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      canvasesByWorkspace: { 'ws-a': [{ slug: 'alpha', updatedAt: new Date().toISOString() }] },
      delayCanvases: gate,
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)

    // While the canvases fetch is in flight: structural skeleton, and no
    // premature "No canvases" copy.
    expect(await screen.findByRole('status', { name: /loading canvases/i })).toBeTruthy()
    expect(screen.queryByText(/no canvases/i)).toBeNull()

    release()
    await screen.findByText('alpha')
    expect(screen.queryByRole('status', { name: /loading canvases/i })).toBeNull()
  })

  it('empty workspace shows one clear next action that starts canvas creation', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      canvasesByWorkspace: { 'ws-a': [] },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)

    expect(await screen.findByText('No canvases yet')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    // The action lands the user in the naming input, ready to type.
    expect(document.activeElement).toBe(screen.getByLabelText('New canvas name'))
  })

  it('offers Grid/Tree as a view toggle of the one canvas surface', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      canvasesByWorkspace: { 'ws-a': [{ slug: 'alpha', updatedAt: new Date().toISOString() }] },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenCanvas={vi.fn()} />)
    await screen.findByText('alpha')

    const grid = screen.getByRole('button', { name: 'Grid view' })
    const tree = screen.getByRole('button', { name: 'Tree view' })
    expect(grid.getAttribute('aria-pressed')).toBe('true')
    expect(tree.getAttribute('aria-pressed')).toBe('false')
  })
})
