import {
  cleanup,
  fireEvent,
  type RenderOptions,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactElement } from 'react'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickNewDocumentKind } from '../test-utils/new-document-menu.js'
import { DaemonIndexPage } from './DaemonIndexPage.js'

// The page now reads useNavigate (Settings navigation), so every render
// needs a Router ancestor — wrapping once here keeps the existing
// `render(<DaemonIndexPage .../>)` call sites throughout this file unchanged.
function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>, options)
}

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface MockRoutes {
  workspaces: Array<{ workspaceId: string }>
  documentsByWorkspace: Record<
    string,
    Array<{ path: string; updatedAt: string; kind?: string; displayName?: string }>
  >
  namesByWorkspace?: Record<
    string,
    { workspace?: string; documents: Record<string, string>; pinned: string[] } | 'fail'
  >
  onCreateDocument?: (workspaceId: string, path: string, kind?: string) => void
  // Return a Response (or a pending promise of one) to override the
  // default 200 {ok:true}.
  onDeleteCanvas?: (workspaceId: string, path: string) => Response | Promise<Response> | undefined
  snapshotByCanvas?: Record<string, Uint8Array>
  onUpdateCanvas?: (workspaceId: string, path: string, bytes: Uint8Array) => void
  onSetCanvasName?: (workspaceId: string, path: string, name: string) => void
  /** When set, the documents fetch resolves only after this promise settles. */
  delayCanvases?: Promise<void>
}

function installFetchMock(routes: MockRoutes) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/api/workspaces') && (!init || init.method === undefined)) {
      return Promise.resolve(jsonResponse({ workspaces: routes.workspaces }))
    }
    const documentsMatch = url.match(/\/api\/workspaces\/([^/]+)\/documents$/)
    if (documentsMatch && (!init || init.method === undefined)) {
      const workspaceId = decodeURIComponent(documentsMatch[1])
      const documents = routes.documentsByWorkspace[workspaceId]
      if (!documents) return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
      const respond = () => jsonResponse({ documents })
      if (routes.delayCanvases) return routes.delayCanvases.then(respond)
      return Promise.resolve(respond())
    }
    if (documentsMatch && init?.method === 'POST') {
      const workspaceId = decodeURIComponent(documentsMatch[1])
      const body = JSON.parse(String(init.body)) as { path: string; kind?: string }
      routes.onCreateDocument?.(workspaceId, body.path, body.kind)
      return Promise.resolve(jsonResponse({ path: body.path }))
    }
    const canvasDeleteMatch = url.match(/\/api\/workspaces\/([^/]+)\/documents\/([^/]+)$/)
    if (canvasDeleteMatch && init?.method === 'DELETE') {
      const workspaceId = decodeURIComponent(canvasDeleteMatch[1])
      const path = decodeURIComponent(canvasDeleteMatch[2])
      const override = routes.onDeleteCanvas?.(workspaceId, path)
      return Promise.resolve(override ?? jsonResponse({ ok: true }))
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
    const snapshotMatch = url.match(/\/api\/w\/([^/]+)\/document\/(.+)\/snapshot$/)
    if (snapshotMatch) {
      const path = decodeURIComponent(snapshotMatch[2])
      const bytes = routes.snapshotByCanvas?.[path]
      if (!bytes) return Promise.resolve(jsonResponse({ title: 'Not found' }, 404))
      return Promise.resolve(
        new Response(bytes as BodyInit, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      )
    }
    const updateMatch = url.match(/\/api\/w\/([^/]+)\/document\/(.+)\/update$/)
    if (updateMatch && init?.method === 'POST') {
      const workspaceId = decodeURIComponent(updateMatch[1])
      const path = decodeURIComponent(updateMatch[2])
      routes.onUpdateCanvas?.(workspaceId, path, new Uint8Array(init.body as ArrayBuffer))
      return Promise.resolve(jsonResponse({ ok: true }))
    }
    const canvasNameMatch = url.match(/\/api\/workspaces\/([^/]+)\/documents\/([^/]+)\/name$/)
    if (canvasNameMatch && init?.method === 'PUT') {
      const workspaceId = decodeURIComponent(canvasNameMatch[1])
      const path = decodeURIComponent(canvasNameMatch[2])
      const body = JSON.parse(String(init.body)) as { name: string }
      routes.onSetCanvasName?.(workspaceId, path, body.name)
      const names = routes.namesByWorkspace?.[workspaceId]
      const documents = names && names !== 'fail' ? names.documents : {}
      return Promise.resolve(
        jsonResponse({ documents: { ...documents, [path]: body.name }, pinned: [] }),
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

// The panel's document cards fill the preview pane on click; Open /
// Duplicate / Delete live there, so acting on a document is select-then-act.
async function selectCard(name: string) {
  fireEvent.click(await screen.findByText(name))
  await screen.findByTestId('okf-preview')
}

describe('DaemonIndexPage', () => {
  it('renders one card per document of the selected workspace with display name and relative updatedAt', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      documentsByWorkspace: {
        // displayName rides on the list row exactly as the daemon's
        // documents table serves it; /names projects the same column.
        'ws-a': [
          { path: 'alpha', displayName: 'Alpha Board', updatedAt: new Date().toISOString() },
        ],
        'ws-b': [{ path: 'beta', updatedAt: new Date().toISOString() }],
      },
      namesByWorkspace: {
        'ws-a': { documents: { alpha: 'Alpha Board' }, pinned: [] },
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

    expect(await screen.findByText('Alpha Board')).toBeTruthy()
    expect(screen.getByTestId('card-subtitle').textContent).toMatch(/ago/)
    expect(screen.queryByText('beta')).toBeNull()
  })

  it('marks a markdown row from the daemon list response as markdown on its card', async () => {
    // The read direction of `kind`: the daemon's documents-list response maps
    // into DocumentRow and reaches the card's text marker. The create/POST
    // direction is covered separately; without this test every page-level
    // mock defaults to spatial and the mapping could silently drop kind.
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [
          { path: 'note', updatedAt: new Date().toISOString(), kind: 'markdown' },
          { path: 'board', updatedAt: new Date().toISOString() },
        ],
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await screen.findByText('note')

    // The kind marker is the card SUBTITLE (`markdown · …`); the thumbnail
    // placeholder is excluded because it labels unknown kinds "markdown" too.
    const cards = screen.getAllByRole('button', { name: /note|board/ })
    const noteCard = cards.find((c) => within(c).queryByText('note'))!
    const boardCard = cards.find((c) => within(c).queryByText('board'))!
    expect(within(noteCard).getByTestId('card-subtitle').textContent).toMatch(/markdown/)
    expect(within(boardCard).getByTestId('card-subtitle').textContent).not.toMatch(/markdown/)
  })

  it('keeps a create entry point when the canvas list fails to load', async () => {
    // A failed listDocuments must not dead-end the page: creating routes
    // around the broken list (the POST needs no rows, and success navigates
    // away), so the error state keeps the same recovery path the toolbar
    // used to provide.
    const created: Array<[string, string]> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {},
      onCreateDocument: (workspaceId, path) => created.push([workspaceId, path]),
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    expect(await screen.findByRole('alert')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith('ws-a', 'untitled'))
    expect(created).toEqual([['ws-a', 'untitled']])
  })

  it('fades the loaded panel in for skeleton-to-content continuity', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

    const panel = await screen.findByTestId('workspace-files-panel')
    const wrapper = panel.closest('.animate-in') as HTMLElement | null
    expect(wrapper).not.toBeNull()
    expect(wrapper?.className).toMatch(/\bfade-in-0\b/)
  })

  it('honors initialWorkspaceId over the daemon-listed first workspace', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
        'ws-b': [{ path: 'beta', updatedAt: new Date().toISOString() }],
      },
    })

    render(
      <DaemonIndexPage
        daemonBaseUrl={DAEMON_BASE_URL}
        initialWorkspaceId="ws-b"
        onOpenDocument={vi.fn()}
      />,
    )

    expect(await screen.findByText('beta')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    expect((screen.getByRole('combobox', { name: 'Workspace' }) as HTMLSelectElement).value).toBe(
      'ws-b',
    )
  })

  it('falls back to the first-listed workspace when initialWorkspaceId is not in the daemon list', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
        'ws-b': [{ path: 'beta', updatedAt: new Date().toISOString() }],
      },
    })

    render(
      <DaemonIndexPage
        daemonBaseUrl={DAEMON_BASE_URL}
        initialWorkspaceId="stale-deleted-workspace"
        onOpenDocument={vi.fn()}
      />,
    )

    expect(await screen.findByText('alpha')).toBeTruthy()
  })

  it('switching the workspace selector replaces the visible cards', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
        'ws-b': [{ path: 'beta', updatedAt: new Date().toISOString() }],
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    expect(await screen.findByText('alpha')).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox', { name: 'Workspace' }), {
      target: { value: 'ws-b' },
    })

    expect(await screen.findByText('beta')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
  })

  it("clears the previous workspace's cards immediately on switch, before the new load resolves", async () => {
    // A stale card clicked in the switch window would pair the NEW workspace
    // id with the OLD workspace's path — a mismatched identity.
    // Each pending call gets its own deferred + fresh Response (a Response
    // body is single-use, and the load may retry/refire).
    // The panel re-reads ws-b AFTER the page's rows arrive, so the gate
    // must stay open once released — a one-shot release would strand the
    // panel's own later fetch and 'beta' would never render.
    const waiters: Array<() => void> = []
    let released = false
    const releaseB = () => {
      released = true
      for (const w of waiters.splice(0)) w()
    }
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(
          jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }] }),
        )
      }
      if (url.includes('/ws-a/documents')) {
        return Promise.resolve(
          jsonResponse({ documents: [{ path: 'alpha', updatedAt: new Date().toISOString() }] }),
        )
      }
      if (url.includes('/ws-b/documents')) {
        const respond = () =>
          jsonResponse({ documents: [{ path: 'beta', updatedAt: new Date().toISOString() }] })
        if (released) return Promise.resolve(respond())
        return new Promise<Response>((resolve) => {
          waiters.push(() => resolve(respond()))
        })
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    expect(await screen.findByText('alpha')).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox', { name: 'Workspace' }), {
      target: { value: 'ws-b' },
    })

    // ws-b's documents request is still pending — the old grid must be gone NOW.
    expect(screen.queryByText('alpha')).toBeNull()

    releaseB()
    expect(await screen.findByText('beta')).toBeTruthy()
  })

  it('sorts pinned documents before unpinned in the folder pane', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [
          { path: 'old', updatedAt: '2020-01-01T00:00:00Z' },
          { path: 'new', updatedAt: '2026-01-01T00:00:00Z' },
          { path: 'pinned-one', updatedAt: '2019-01-01T00:00:00Z' },
        ],
      },
      namesByWorkspace: {
        'ws-a': { documents: {}, pinned: ['pinned-one'] },
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await screen.findByText('pinned-one')

    // Non-vacuous: by the pane's path order alone, `pinned-one` sorts LAST.
    const titles = screen.getAllByTestId('card-title').map((el) => el.textContent)
    expect(titles).toEqual(['pinned-one', 'new', 'old'])
  })

  it('filters cards by search input matching path or display name', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [
          { path: 'alpha', updatedAt: new Date().toISOString() },
          { path: 'beta', updatedAt: new Date().toISOString() },
        ],
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await screen.findByText('alpha')

    fireEvent.change(screen.getByLabelText('Search documents'), { target: { value: 'bet' } })

    // The match highlight splits the title across a <mark>, so read the
    // row's textContent rather than matching a contiguous text node.
    expect(screen.queryByText('alpha')).toBeNull()
    const titles = (await screen.findAllByTestId('result-title')).map((el) => el.textContent)
    expect(titles).toEqual(['beta'])
  })

  it('degrades gracefully to unpinned/path-only when the names fetch fails', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
      },
      namesByWorkspace: { 'ws-a': 'fail' },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    expect(await screen.findByText('alpha')).toBeTruthy()
  })

  it('shows an alert (not a blank page) when listDocuments fails for the selected workspace', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {},
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('shows an alert when the initial workspace list fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ message: 'boom' }, 500))),
    )

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

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
      if (url.endsWith('/api/workspaces/ws-a/documents')) {
        return new Promise<Response>((resolve) => {
          resolveA = resolve
        })
      }
      if (url.endsWith('/api/workspaces/ws-b/documents')) {
        return Promise.resolve(
          jsonResponse({ documents: [{ path: 'beta', updatedAt: new Date().toISOString() }] }),
        )
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Workspace' })).toBeTruthy())
    fireEvent.change(screen.getByRole('combobox', { name: 'Workspace' }), {
      target: { value: 'ws-b' },
    })
    expect(await screen.findByText('beta')).toBeTruthy()

    resolveA?.(
      jsonResponse({ documents: [{ path: 'alpha', updatedAt: new Date().toISOString() }] }),
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByText('beta')).toBeTruthy()
  })

  it('calls onOpenDocument with the card identity via the preview Open action', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
      },
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    await selectCard('alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    expect(onOpenDocument).toHaveBeenCalledExactlyOnceWith('ws-a', 'alpha')
  })

  it('duplicates a canvas via the preview Duplicate action without opening it', async () => {
    const updates: Array<[string, string, Uint8Array]> = []
    const created: Array<[string, string]> = []
    const names: Array<[string, string, string]> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', displayName: 'Alpha', updatedAt: new Date().toISOString() }],
      },
      namesByWorkspace: { 'ws-a': { documents: { alpha: 'Alpha' }, pinned: [] } },
      snapshotByCanvas: { alpha: new Uint8Array([1, 2, 3]) },
      onCreateDocument: (workspaceId, path) => created.push([workspaceId, path]),
      onUpdateCanvas: (workspaceId, path, bytes) => updates.push([workspaceId, path, bytes]),
      onSetCanvasName: (workspaceId, path, name) => names.push([workspaceId, path, name]),
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    await selectCard('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))

    await waitFor(() => {
      expect(created).toEqual([['ws-a', 'alpha-copy']])
    })
    expect(updates).toEqual([['ws-a', 'alpha-copy', new Uint8Array([1, 2, 3])]])
    expect(names).toEqual([['ws-a', 'alpha-copy', 'Alpha (copy)']])
    // Clicking the Duplicate action must not also open the source canvas.
    expect(onOpenDocument).not.toHaveBeenCalled()
  })

  it('a second Duplicate press while one is in flight starts no second copy', async () => {
    let resolveSnapshot: ((res: Response) => void) | undefined
    let snapshotCalls = 0
    const created: Array<[string, string]> = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces') && (!init || init.method === undefined)) {
        return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }] }))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents') && (!init || init.method === undefined)) {
        // markdown: the panel's thumbnail/preview loaders then read OKF (a
        // harmless 404 below) instead of racing this test's deferred
        // snapshot read, which must stay the duplicate's alone.
        return Promise.resolve(
          jsonResponse({
            documents: [
              {
                path: 'alpha',
                displayName: 'Alpha',
                updatedAt: new Date().toISOString(),
                kind: 'markdown',
              },
            ],
          }),
        )
      }
      if (url.endsWith('/api/workspaces/ws-a/documents') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { path: string }
        created.push(['ws-a', body.path])
        return Promise.resolve(jsonResponse({ path: body.path }))
      }
      if (url.endsWith('/api/workspaces/ws-a/names')) {
        return Promise.resolve(jsonResponse({ documents: { alpha: 'Alpha' }, pinned: [] }))
      }
      if (url.endsWith('/api/w/ws-a/document/alpha/snapshot')) {
        snapshotCalls++
        return new Promise<Response>((resolve) => {
          resolveSnapshot = resolve
        })
      }
      if (/\/api\/document\/ws-a\/[^/]+\/update$/.test(url) && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (/\/api\/workspaces\/ws-a\/documents\/[^/]+\/name$/.test(url) && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ documents: { alpha: 'Alpha' }, pinned: [] }))
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await selectCard('Alpha')
    const duplicateBtn = screen.getByRole('button', { name: 'Duplicate' })
    fireEvent.click(duplicateBtn)
    await waitFor(() => expect(snapshotCalls).toBe(1))

    // React has flushed the in-flight state by the second press; the
    // handler's guard must swallow it — no second snapshot read.
    fireEvent.click(duplicateBtn)
    expect(snapshotCalls).toBe(1)

    resolveSnapshot?.(
      new Response(new Uint8Array([1, 2, 3]) as BodyInit, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    )
    await waitFor(() => expect(created).toEqual([['ws-a', 'alpha-copy']]))
    vi.unstubAllGlobals()
  })

  it('shows an alert and keeps the Duplicate button usable when duplicating fails', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', displayName: 'Alpha', updatedAt: new Date().toISOString() }],
      },
      namesByWorkspace: { 'ws-a': { documents: { alpha: 'Alpha' }, pinned: [] } },
      // No snapshotByCanvas entry for 'alpha' -> the mock 404s the snapshot read.
    })
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await selectCard('Alpha')
    const duplicateBtn = screen.getByRole('button', { name: 'Duplicate' }) as HTMLButtonElement
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
      if (url.endsWith('/api/workspaces/ws-a/documents') && (!init || init.method === undefined)) {
        return Promise.resolve(
          jsonResponse({
            documents: [{ path: 'alpha', updatedAt: new Date().toISOString(), kind: 'markdown' }],
          }),
        )
      }
      if (url.endsWith('/api/workspaces/ws-b/documents') && (!init || init.method === undefined)) {
        return Promise.resolve(
          jsonResponse({
            documents: [{ path: 'beta', updatedAt: new Date().toISOString(), kind: 'markdown' }],
          }),
        )
      }
      if (url.endsWith('/api/workspaces/ws-a/documents') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { path: string }
        return Promise.resolve(jsonResponse({ path: body.path }))
      }
      if (
        url.endsWith('/api/workspaces/ws-a/names') ||
        url.endsWith('/api/workspaces/ws-b/names')
      ) {
        return Promise.resolve(jsonResponse({ documents: {}, pinned: [] }))
      }
      if (url.endsWith('/api/w/ws-a/document/alpha/snapshot')) {
        return new Promise<Response>((resolve) => {
          resolveSnapshot = resolve
        })
      }
      if (/\/api\/document\/ws-a\/[^/]+\/update$/.test(url) && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (/\/api\/workspaces\/ws-a\/documents\/[^/]+\/name$/.test(url) && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ documents: {}, pinned: [] }))
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await selectCard('alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))

    // Switch workspaces while the duplicate (still reading alpha's snapshot) is in flight.
    fireEvent.change(screen.getByRole('combobox', { name: 'Workspace' }), {
      target: { value: 'ws-b' },
    })
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

  it("creates a canvas from the panel's New menu, opening it with no name typed first", async () => {
    const created: Array<[string, string]> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'existing', updatedAt: new Date().toISOString() }],
      },
      onCreateDocument: (workspaceId, path) => created.push([workspaceId, path]),
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    await screen.findByText('existing')

    await pickNewDocumentKind('spatial')

    await waitFor(() => expect(created).toEqual([['ws-a', 'untitled']]))
    // Creating ends where the next thing happens — an empty document is
    // worth nothing until it is open, and the panel was the last creation
    // path in the app that left you looking at a card instead. The open
    // folder is in the address now, so the way back is not a trip to the
    // workspace root.
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith('ws-a', 'untitled'))
    // Still no form in front of it: naming does not gate creation.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('creates a markdown document from the panel button, sending kind to the daemon', async () => {
    const created: Array<[string, string, string | undefined]> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'existing', updatedAt: new Date().toISOString() }],
      },
      onCreateDocument: (workspaceId, path, kind) => created.push([workspaceId, path, kind]),
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    await screen.findByText('existing')

    await pickNewDocumentKind('markdown')

    await waitFor(() => expect(created).toEqual([['ws-a', 'untitled', 'markdown']]))
  })

  it('derives a unique path from the listed documents, skipping an already-used "untitled"', async () => {
    const created: Array<[string, string]> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'untitled', updatedAt: new Date().toISOString() }],
      },
      onCreateDocument: (workspaceId, path) => created.push([workspaceId, path]),
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    await screen.findByText('untitled')

    await pickNewDocumentKind('spatial')

    await waitFor(() => expect(created).toEqual([['ws-a', 'untitled-2']]))
  })

  it('shows an alert when create canvas fails', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }] }))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ message: 'boom' }, 500))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents')) {
        return Promise.resolve(jsonResponse({ documents: [] }))
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    // Empty workspace: the empty state's create action is the entry point.
    fireEvent.click(await screen.findByRole('button', { name: 'Create a canvas' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Request failed (500).')
    expect(screen.queryByText(/boom/)).toBeNull()
    expect(onOpenDocument).not.toHaveBeenCalled()
  })

  // The `disabled` attribute only protects AFTER React re-renders. Two presses inside one tick
  // (a real double-click, or Enter held down) both run the handler, and a guard that reads
  // `creating` from the render closure still sees `false` in the second — so it must not be the
  // only defence. Two POSTs deriving the same path means the loser 409s.
  it('sends one create for two presses inside a single tick', async () => {
    const created: string[] = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }] }))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents') && init?.method === 'POST') {
        created.push(JSON.parse(String(init.body)).path as string)
        return Promise.resolve(jsonResponse({ path: 'untitled' }))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents')) {
        return Promise.resolve(jsonResponse({ documents: [] }))
      }
      return Promise.resolve(jsonResponse({ documents: {}, pinned: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    // Empty workspace: the empty state's create action is the direct-click
    // entry point (the toolbar + goes through a menu, which cannot fire
    // twice in one tick — its item unmounts on the first select).
    const button = await screen.findByRole('button', { name: 'Create a canvas' })

    // No await between them: React has not re-rendered, so `disabled` is not yet set.
    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalled())
    expect(created).toEqual(['untitled'])
  })

  it('disables the empty state create button while in flight, and double-clicking creates exactly one', async () => {
    let resolveCreate: ((res: Response) => void) | undefined
    const created: string[] = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }] }))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents') && init?.method === 'POST') {
        created.push(JSON.parse(String(init.body)).path as string)
        return new Promise<Response>((resolve) => {
          resolveCreate = resolve
        })
      }
      if (url.endsWith('/api/workspaces/ws-a/documents')) {
        return Promise.resolve(jsonResponse({ documents: [] }))
      }
      return Promise.resolve(jsonResponse({ documents: {}, pinned: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    const button = await screen.findByRole('button', { name: 'Create a canvas' })

    fireEvent.click(button)
    await waitFor(() => expect(created).toEqual(['untitled']))
    // The create is still in flight: the control must be disabled AND a second press a no-op.
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true))
    fireEvent.click(button)
    expect(created).toEqual(['untitled'])

    resolveCreate?.(jsonResponse({ path: 'untitled' }))
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1))
    expect(created).toEqual(['untitled'])
  })

  // Reproduces the defect the dev-loop's QA agent found: after a failed create the list was never
  // re-fetched, so the next click re-derived the SAME path from stale rows and collided again,
  // deterministically, until the user reloaded the page.
  it('re-reads the list after a failed create so the retry does not repeat the same path', async () => {
    const created: string[] = []
    let serverPaths: string[] = ['untitled']
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }] }))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents') && init?.method === 'POST') {
        const path = JSON.parse(String(init?.body ?? '{}')).path as string
        created.push(path)
        if (serverPaths.includes(path)) {
          return Promise.resolve(jsonResponse({ title: `Canvas "${path}" already exists` }, 409))
        }
        serverPaths = [...serverPaths, path]
        return Promise.resolve(jsonResponse({ path }))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents')) {
        // The list starts EMPTY (a second tab created "untitled"), so the first derive collides.
        return Promise.resolve(
          jsonResponse({
            documents:
              created.length === 0
                ? []
                : serverPaths.map((path) => ({ path, updatedAt: new Date().toISOString() })),
          }),
        )
      }
      return Promise.resolve(jsonResponse({ names: {} }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    // The list starts empty, so the first create goes through the empty state.
    fireEvent.click(await screen.findByRole('button', { name: 'Create a canvas' }))
    expect((await screen.findByRole('alert')).textContent).toContain('already exists')

    // The failed create re-reads the list, which now shows the colliding
    // canvas — the page leaves the onboarding state and mounts the panel,
    // whose own create button must not repeat the losing path.
    await screen.findByText('untitled')
    await pickNewDocumentKind('spatial')

    await waitFor(() => expect(created).toEqual(['untitled', 'untitled-2']))
    // The point of this test is the PATH the retry picks, not where the user
    // ends up — but both creates open what they made now, so the onboarding
    // one having fired first is why this asserts on the second.
    await waitFor(() => expect(onOpenDocument).toHaveBeenLastCalledWith('ws-a', 'untitled-2'))
  })

  it('the delete dialog names the kind: note for markdown, canvas for spatial', async () => {
    // Hardcoding "canvas" back into this page's dialog must go red here —
    // the local page has the same pin, and the daemon page is not exempt.
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [
          {
            path: 'meeting-notes',
            displayName: 'Meeting notes',
            updatedAt: '2026-08-01T00:00:00Z',
            kind: 'markdown',
          },
          {
            path: 'trip-plan',
            displayName: 'Trip plan',
            updatedAt: '2026-08-02T00:00:00Z',
            kind: 'spatial',
          },
        ],
      },
    })
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />, {
      container: document.body,
    })

    await selectCard('Meeting notes')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    let dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/removes the note, including its versions/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    await selectCard('Trip plan')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/removes the canvas, including its versions/)).toBeTruthy()
  })

  it('Delete opens an AlertDialog naming the canvas; Cancel sends no DELETE', async () => {
    const deleted: string[] = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [
          { path: 'alpha', displayName: 'Alpha Board', updatedAt: new Date().toISOString() },
        ],
      },
      namesByWorkspace: { 'ws-a': { documents: { alpha: 'Alpha Board' }, pinned: [] } },
      onDeleteCanvas: (_ws, path) => {
        deleted.push(path)
        return undefined
      },
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />, {
      container: document.body,
    })
    await selectCard('Alpha Board')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/Delete "Alpha Board"\?/)).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(deleted).toEqual([])
    // Card title AND the preview heading both say it — still present, twice.
    expect(screen.getAllByText('Alpha Board').length).toBeGreaterThan(0)
    expect(onOpenDocument).not.toHaveBeenCalled()
  })

  it('confirming Delete sends DELETE and the card disappears from the refreshed list', async () => {
    const deleted: string[] = []
    let rows = [
      { path: 'alpha', updatedAt: new Date().toISOString() },
      { path: 'beta', updatedAt: new Date().toISOString() },
    ]
    const routes: Parameters<typeof installFetchMock>[0] = {
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        get 'ws-a'() {
          return rows
        },
      },
      onDeleteCanvas: (_ws, path) => {
        deleted.push(path)
        rows = rows.filter((r) => r.path !== path)
        return undefined
      },
    }
    installFetchMock(routes)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />, {
      container: document.body,
    })
    await selectCard('alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    )

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(deleted).toEqual(['alpha'])
    await waitFor(() => expect(screen.queryByText('alpha')).toBeNull())
    expect(screen.getByText('beta')).toBeTruthy()
  })

  it('sends exactly one DELETE for two confirm presses inside a single tick', async () => {
    // Same mechanism as the create tests: React flushes `deleting` before a
    // second click can dispatch on the now-disabled confirm button.
    let resolveDelete: ((res: Response) => void) | undefined
    const deleted: string[] = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
      },
      onDeleteCanvas: (_ws, path) => {
        deleted.push(path)
        return new Promise<Response>((resolve) => {
          resolveDelete = resolve
        })
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />, {
      container: document.body,
    })
    await selectCard('alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const confirm = within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: 'Delete',
    })
    // No await between them: the disabled flush is the guard under test.
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    await waitFor(() => expect(deleted).toEqual(['alpha']))
    resolveDelete?.(jsonResponse({ ok: true }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(deleted).toEqual(['alpha'])
  })

  it('a failed Delete shows the sanitized error in the dialog and refreshes after dismissal', async () => {
    let listFetches = 0
    let rows = [{ path: 'alpha', updatedAt: new Date().toISOString() }]
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        get 'ws-a'() {
          listFetches += 1
          return rows
        },
      },
      onDeleteCanvas: () => jsonResponse({ title: 'Canvas not found' }, 404),
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />, {
      container: document.body,
    })
    await selectCard('alpha')
    const fetchesBefore = listFetches

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    // The dialog stays open showing the daemon's sanitized title...
    expect(await within(dialog).findByText('Canvas not found')).toBeTruthy()
    // ...and dismissing it refreshes the list so a stale row (404 = already
    // gone on the daemon) cannot linger.
    rows = []
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(listFetches).toBeGreaterThan(fetchesBefore))
    await waitFor(() => expect(screen.queryByText('alpha')).toBeNull())
  })

  it('has no Storage tab — storage and pairing live on the routed Settings page (design refactor D2)', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }] },
    })

    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />,
        },
      ],
      { initialEntries: ['/'] },
    )
    rtlRender(<RouterProvider router={router} />)
    await screen.findByText('alpha')

    // The top level is the canvas surface only: no tablist at all.
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Storage' })).toBeNull()

    // The operational surfaces (storage, pairing) live on their own route,
    // reached through the App-mounted shell's gear — the page itself owns no
    // settings affordance at all (AppShell ownership rule in DESIGN.md).
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
  })

  it('hides the workspace selector when there is only one workspace (raw id demoted, D3)', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'dTMMrBP3c5ah8_SXTRVvC' }],
      documentsByWorkspace: {
        dTMMrBP3c5ah8_SXTRVvC: [{ path: 'alpha', updatedAt: new Date().toISOString() }],
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await screen.findByText('alpha')

    // One workspace = nothing to choose; the raw id has no reason to be
    // page chrome. Multi-workspace daemons keep the selector.
    expect(screen.queryByRole('combobox', { name: 'Workspace' })).toBeNull()
  })

  it('names the create control in text and hides its glyph from the accessible name', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }] },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await screen.findByText('alpha')

    const button = screen.getByRole('button', { name: 'New document' })
    expect(button.getAttribute('aria-label')).toBe('New document')
    // WCAG 2.5.3: the visible label is a substring of the accessible name,
    // so "click New" reaches this control by voice. The glyph stays out of
    // the name entirely.
    expect(button.textContent).toContain('New')
    const svg = button.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })

  it('mounts no permanent creation form in the toolbar (ADR-0006)', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }] },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await screen.findByText('alpha')

    expect(screen.queryByLabelText(/new canvas name/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create canvas' })).toBeNull()
  })

  it('shows a loading skeleton before the first load resolves, never a false empty state', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }] },
      delayCanvases: gate,
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

    // While the documents fetch is in flight: structural skeleton, and no
    // premature "No documents" copy.
    expect(await screen.findByRole('status', { name: /loading documents/i })).toBeTruthy()
    expect(screen.queryByText(/no documents/i)).toBeNull()

    release()
    await screen.findByText('alpha')
    expect(screen.queryByRole('status', { name: /loading documents/i })).toBeNull()
  })

  it('empty workspace shows one clear next action that creates and opens a canvas', async () => {
    const created: Array<[string, string]> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': [] },
      onCreateDocument: (workspaceId, path) => created.push([workspaceId, path]),
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)

    expect(await screen.findByText('What will you make first?')).toBeTruthy()
    // Mode-honest copy: the daemon page must NOT show local mode's
    // "stays in this browser" promise — documents live in the daemon here.
    expect(screen.getByTestId('empty-state-subtitle').textContent).toBe(
      'Documents live in this workspace, kept by your local daemon.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))

    // The action creates immediately — no naming step gates it — and opens
    // the result, same as the toolbar's "New canvas" control.
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith('ws-a', 'untitled'))
    expect(created).toEqual([['ws-a', 'untitled']])
  })

  it('the empty state also offers a markdown note, sending its kind and opening it', async () => {
    // The onboarding moment is where a writing-first user arrives too — an
    // empty state that can only make a canvas turns them away at the door.
    const kinds: Array<string | undefined> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': [] },
      onCreateDocument: (_workspaceId, _path, kind) => kinds.push(kind),
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)

    await screen.findByText('What will you make first?')
    fireEvent.click(screen.getByRole('button', { name: 'Create a markdown note' }))

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith('ws-a', 'untitled'))
    expect(kinds).toEqual(['markdown'])
  })

  it('renders the panel as the one document surface, with no view toggle left', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }] },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await screen.findByText('alpha')

    expect(screen.getByTestId('workspace-files-panel')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Grid view' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Tree view' })).toBeNull()
  })
})
