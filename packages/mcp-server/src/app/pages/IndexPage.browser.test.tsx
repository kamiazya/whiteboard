import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import '../index.css'
import IndexPage from './IndexPage.js'

// Test-only probe: renders the current pathname so navigation assertions can
// read the post-create destination without a real router.
function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}</div>
}

type FetchArgs = [RequestInfo | URL, RequestInit?]

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  // Two workspaces with canvases of differing freshness exercise the flat
  // canvas-first rendering: workspace identity is internal-only now, so the
  // test asserts canvases are merged and sorted by updatedAt regardless of
  // which workspace they came from.
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>((input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url === '/api/workspaces') {
      return Promise.resolve(
        jsonResponse({
          workspaces: [{ workspaceId: 'ws_1' }, { workspaceId: 'ws_2' }],
        }),
      )
    }
    if (url === '/api/workspaces/ws_1/canvases') {
      return Promise.resolve(
        jsonResponse({
          canvases: [
            { slug: 'design/login', updatedAt: '2026-04-26T10:00:00.000Z' },
            { slug: 'design/old', updatedAt: '2026-04-20T08:00:00.000Z' },
          ],
        }),
      )
    }
    if (url === '/api/workspaces/ws_2/canvases') {
      return Promise.resolve(
        jsonResponse({
          canvases: [
            { slug: 'sketches/inbox', updatedAt: '2026-04-27T11:00:00.000Z' },
          ],
        }),
      )
    }
    if (url === '/api/workspaces/ws_1/names') {
      return Promise.resolve(
        jsonResponse({
          workspace: 'Main workspace',
          canvases: { 'design/login': 'Login flow' },
          // Older `design/old` is pinned — must rank ABOVE the freshest
          // unpinned canvas (`sketches/inbox`) on IndexPage.
          pinned: ['design/old'],
        }),
      )
    }
    if (url === '/api/workspaces/ws_2/names') {
      return Promise.resolve(jsonResponse({ workspace: 'Sketches', canvases: {}, pinned: [] }))
    }
    if (url === '/api/runtime/storage') {
      return Promise.resolve(
        jsonResponse({
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
      )
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
  // The "reuses the freshly-minted workspace id" case writes
  // whiteboard.indexPage.primaryWorkspaceId; clear it here so later
  // browser tests in the same suite do not silently rehydrate from a
  // previous case's stash.
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem('whiteboard.indexPage.primaryWorkspaceId')
    } catch {
      // Defensive — some envs may disallow storage access.
    }
  }
})

describe('IndexPage browser mode', () => {
  it('puts pinned canvases first regardless of recency, then sorts the rest by updatedAt desc', async () => {
    const { container } = render(
      <MemoryRouter>
        <div className="min-h-screen w-[1100px] bg-background p-6">
          <IndexPage />
        </div>
      </MemoryRouter>,
    )

    await expect.element(page.getByRole('link', { name: /sketches\/inbox/i })).toBeInTheDocument()
    await waitFor(() => {
      const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
      // apiFetch always attaches a Headers object (carrier for OTel
      // traceparent injection), so we assert URL only.
      const calledUrls = fetchMock.mock.calls.map((c: unknown[]) => c[0])
      expect(calledUrls).toContain('/api/workspaces')
      expect(calledUrls).toContain('/api/workspaces/ws_1/canvases')
      expect(calledUrls).toContain('/api/workspaces/ws_2/canvases')
    })

    // The display name from the names API takes precedence over the slug.
    await expect.element(page.getByRole('link', { name: /Login flow/i })).toBeInTheDocument()

    const linkTexts = Array.from(container.querySelectorAll('a'))
      .map((a) => a.textContent?.trim() ?? '')
      .filter((t) => t.includes('sketches/inbox') || t.includes('design/'))
    expect(linkTexts.length).toBeGreaterThanOrEqual(3)
    // design/old is pinned → must be FIRST despite being the oldest. Then
    // unpinned canvases follow in updatedAt desc: sketches/inbox, then
    // Login flow (design/login).
    expect(linkTexts[0]).toMatch(/design\/old/)
    expect(linkTexts[1]).toMatch(/sketches\/inbox/)
    expect(linkTexts[2]).toMatch(/Login flow|design\/login/)
  })

  it('toggles pin state via PUT /api/workspaces/:ws/canvases/:slug/pin when the Pin button is clicked', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (init?.method === 'PUT' && url.endsWith('/canvases/sketches%2Finbox/pin')) {
        return Promise.resolve(
          jsonResponse({ workspace: 'Sketches', canvases: {}, pinned: ['sketches/inbox'] }),
        )
      }
      // Re-route everything else through the original handler.
      if (url === '/api/workspaces') {
        return Promise.resolve(
          jsonResponse({ workspaces: [{ workspaceId: 'ws_1' }, { workspaceId: 'ws_2' }] }),
        )
      }
      if (url === '/api/workspaces/ws_1/canvases') {
        return Promise.resolve(
          jsonResponse({
            canvases: [
              { slug: 'design/login', updatedAt: '2026-04-26T10:00:00.000Z' },
              { slug: 'design/old', updatedAt: '2026-04-20T08:00:00.000Z' },
            ],
          }),
        )
      }
      if (url === '/api/workspaces/ws_2/canvases') {
        return Promise.resolve(
          jsonResponse({
            canvases: [{ slug: 'sketches/inbox', updatedAt: '2026-04-27T11:00:00.000Z' }],
          }),
        )
      }
      if (url === '/api/workspaces/ws_1/names') {
        return Promise.resolve(
          jsonResponse({
            workspace: 'Main workspace',
            canvases: { 'design/login': 'Login flow' },
            pinned: [],
          }),
        )
      }
      if (url === '/api/workspaces/ws_2/names') {
        return Promise.resolve(jsonResponse({ workspace: 'Sketches', canvases: {}, pinned: [] }))
      }
      if (url === '/api/runtime/storage') {
        return Promise.resolve(
          jsonResponse({
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
        )
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    const { container } = render(
      <MemoryRouter>
        <div className="min-h-screen w-[1100px] bg-background p-6">
          <IndexPage />
        </div>
      </MemoryRouter>,
    )

    await expect
      .element(page.getByRole('button', { name: /^pin canvas: sketches\/inbox$/i }))
      .toBeInTheDocument()

    const pinBtn = container.querySelector(
      'button[aria-label="Pin canvas: sketches/inbox"]',
    ) as HTMLButtonElement
    expect(pinBtn).not.toBeNull()
    pinBtn.click()

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/workspaces/ws_2/canvases/sketches%2Finbox/pin',
        expect.objectContaining({ method: 'PUT' }),
      )
    })
  })

  it('does not surface workspace identity in the rendered tree', async () => {
    const { container } = render(
      <MemoryRouter>
        <div className="min-h-screen w-[1100px] bg-background p-6">
          <IndexPage />
        </div>
      </MemoryRouter>,
    )

    await expect.element(page.getByRole('link', { name: /sketches\/inbox/i })).toBeInTheDocument()
    // Workspace concept is internal-only in OSS Local mode now.
    expect(container.textContent).not.toContain('Main workspace')
    expect(container.textContent).not.toContain('Sketches')
    expect(container.textContent).not.toContain('Untitled workspace')
    expect(container.textContent).not.toContain('ws_1')
    expect(container.textContent).not.toContain('ws_2')
    // And the obsolete daemon-status chrome must stay gone.
    expect(container.textContent).not.toContain('daemon live')
    expect(container.textContent).not.toContain('daemon offline')
    expect(container.textContent).not.toContain('Live daemon only')
  })

  it('renders a theme toggle in the header so users can flip light/dark/system without leaving the index', async () => {
    render(
      <MemoryRouter>
        <div className="min-h-screen w-[1100px] bg-background p-6">
          <IndexPage />
        </div>
      </MemoryRouter>,
    )

    await expect.element(page.getByRole('link', { name: /sketches\/inbox/i })).toBeInTheDocument()
    // The toggle is the same shared affordance used by the canvas top bar; on
    // IndexPage it must be reachable by aria-label, not buried behind a menu.
    await expect
      .element(page.getByRole('button', { name: /theme/i }))
      .toBeInTheDocument()
  })

  it('lets the user create a new canvas from the header and navigates to it', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      // Reuse the default GET handlers from beforeEach.
      if (init?.method === 'POST' && url === '/api/workspaces/ws_1/canvases') {
        return Promise.resolve(jsonResponse({ slug: 'fresh-idea' }))
      }
      if (url === '/api/workspaces') {
        return Promise.resolve(
          jsonResponse({ workspaces: [{ workspaceId: 'ws_1' }, { workspaceId: 'ws_2' }] }),
        )
      }
      if (url === '/api/workspaces/ws_1/canvases') {
        return Promise.resolve(jsonResponse({ canvases: [] }))
      }
      if (url === '/api/workspaces/ws_2/canvases') {
        return Promise.resolve(jsonResponse({ canvases: [] }))
      }
      if (url.endsWith('/names')) {
        return Promise.resolve(jsonResponse({ canvases: {}, pinned: [] }))
      }
      if (url === '/api/runtime/storage') {
        return Promise.resolve(
          jsonResponse({
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
        )
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<><IndexPage /><LocationProbe /></>} />
          <Route path="/canvas/:wid/:slug" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    )

    // Wait for IndexPage to leave its loading branch (the affordance only
    // renders once the workspace list resolves).
    await expect.element(page.getByRole('heading', { name: /Whiteboard/i })).toBeInTheDocument()

    // The affordance must be reachable by accessible name; we do not want the
    // entry point hidden behind a kebab menu.
    const trigger = await page.getByRole('button', { name: /new canvas/i }).element()
    ;(trigger as HTMLButtonElement).click()

    // Dialog content is portalled to <body>, so query the global document
    // rather than the test container.
    const inputEl = (await waitFor(() => {
      const el = document.getElementById('new-canvas-slug') as HTMLInputElement | null
      if (!el) throw new Error('slug input not yet mounted')
      return el
    })) as HTMLInputElement
    fireEvent.change(inputEl, { target: { value: 'fresh-idea' } })

    const submit = await page.getByRole('button', { name: /^create$/i }).element()
    fireEvent.submit(submit.closest('form')!)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/workspaces/ws_1/canvases',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('fresh-idea'),
        }),
      )
    })

    await waitFor(() => {
      const loc = container.querySelector('[data-testid="loc"]')?.textContent ?? ''
      expect(loc).toMatch(/^\/canvas\/ws_1\/fresh-idea$/)
    })
  })

  it('reuses the freshly-minted workspace id across sequential creates when no workspaces exist yet', async () => {
    // Cold-start flow: GET /api/workspaces returns []. The first New
    // canvas mints a workspace id; the second click MUST land in the same
    // workspace, otherwise every successive canvas spawns its own
    // throwaway workspace and the user can never group them together
    // until a page reload.
    const postedWorkspaceIds: string[] = []
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (init?.method === 'POST' && url.startsWith('/api/workspaces/') && url.endsWith('/canvases')) {
        const wid = url.split('/')[3]
        postedWorkspaceIds.push(wid)
        return Promise.resolve(jsonResponse({ slug: 'first' }))
      }
      if (url === '/api/workspaces') {
        // No pre-existing workspaces — the dialog has to mint one.
        return Promise.resolve(jsonResponse({ workspaces: [] }))
      }
      if (url === '/api/runtime/storage') {
        return Promise.resolve(
          jsonResponse({
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
        )
      }
      if (url.endsWith('/canvases')) return Promise.resolve(jsonResponse({ canvases: [] }))
      if (url.endsWith('/names')) return Promise.resolve(jsonResponse({ canvases: {}, pinned: [] }))
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    // Clean slate so the test does not pick up another test's stash.
    if (typeof window !== 'undefined') window.localStorage.clear()

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<IndexPage />} />
          {/* Stub destination so the post-create navigate has somewhere to go. */}
          <Route path="/canvas/:wid/*" element={<div data-testid="canvas-page" />} />
        </Routes>
      </MemoryRouter>,
    )

    await expect.element(page.getByRole('heading', { name: /Whiteboard/i })).toBeInTheDocument()

    // First create: empty workspaces list, dialog mints a fresh id.
    const trigger = await page.getByRole('button', { name: /new canvas/i }).element()
    ;(trigger as HTMLButtonElement).click()
    const inputEl = (await waitFor(() => {
      const el = document.getElementById('new-canvas-slug') as HTMLInputElement | null
      if (!el) throw new Error('slug input not yet mounted')
      return el
    })) as HTMLInputElement
    fireEvent.change(inputEl, { target: { value: 'first' } })
    const submit = await page.getByRole('button', { name: /^create$/i }).element()
    fireEvent.submit(submit.closest('form')!)

    await waitFor(() => {
      expect(postedWorkspaceIds).toHaveLength(1)
    })
    const firstWs = postedWorkspaceIds[0]
    expect(firstWs).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(firstWs.length).toBeGreaterThan(0)

    // The whole point of the regression: the minted id must be persisted
    // somewhere durable (localStorage) so the next IndexPage mount
    // reuses it. Without this, every cold-start create spawns a fresh
    // workspace and orphans the previous canvas.
    expect(window.localStorage.getItem('whiteboard.indexPage.primaryWorkspaceId')).toBe(firstWs)

    // And the bug-mirror: a fresh IndexPage mount (the user navigates back
    // to `/` after seeing their new canvas) reads the id from
    // localStorage and uses it as `workspaceId`. Verify by remounting
    // and asserting the next POST goes to the same workspace id.
    cleanup()

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<IndexPage />} />
          <Route path="/canvas/:wid/*" element={<div data-testid="canvas-page" />} />
        </Routes>
      </MemoryRouter>,
    )

    await expect.element(page.getByRole('heading', { name: /Whiteboard/i })).toBeInTheDocument()
    const trigger2 = await page.getByRole('button', { name: /new canvas/i }).element()
    ;(trigger2 as HTMLButtonElement).click()
    const inputEl2 = (await waitFor(() => {
      const el = document.getElementById('new-canvas-slug') as HTMLInputElement | null
      if (!el) throw new Error('slug input not yet mounted (second mount)')
      return el
    })) as HTMLInputElement
    fireEvent.change(inputEl2, { target: { value: 'second' } })
    const submit2 = await page.getByRole('button', { name: /^create$/i }).element()
    fireEvent.submit(submit2.closest('form')!)

    await waitFor(() => {
      expect(postedWorkspaceIds).toHaveLength(2)
    })
    expect(postedWorkspaceIds[1]).toBe(firstWs)
  })

  it('exposes Optimize on each canvas card kebab and POSTs to the compact endpoint', async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (init?.method === 'POST' && url.endsWith('/canvases/sketches%2Finbox/compact')) {
        return Promise.resolve(
          jsonResponse({ compacted: true, beforeBytes: 4096, afterBytes: 1024, reason: 'ok' }),
        )
      }
      // Re-route everything else through the default GETs from beforeEach.
      if (url === '/api/workspaces') {
        return Promise.resolve(
          jsonResponse({ workspaces: [{ workspaceId: 'ws_1' }, { workspaceId: 'ws_2' }] }),
        )
      }
      if (url === '/api/workspaces/ws_1/canvases') {
        return Promise.resolve(jsonResponse({ canvases: [] }))
      }
      if (url === '/api/workspaces/ws_2/canvases') {
        return Promise.resolve(
          jsonResponse({
            canvases: [{ slug: 'sketches/inbox', updatedAt: '2026-04-27T11:00:00.000Z' }],
          }),
        )
      }
      if (url.endsWith('/names')) {
        return Promise.resolve(jsonResponse({ canvases: {}, pinned: [] }))
      }
      if (url === '/api/runtime/storage') {
        return Promise.resolve(
          jsonResponse({
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
        )
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    })

    const { container } = render(
      <MemoryRouter>
        <div className="min-h-screen w-[1100px] bg-background p-6">
          <IndexPage />
        </div>
      </MemoryRouter>,
    )

    await expect.element(page.getByRole('link', { name: /sketches\/inbox/i })).toBeInTheDocument()

    // Each card surfaces a kebab labelled by its slug so future actions can
    // be added without restructuring the layout. Radix DropdownMenu listens
    // on pointer events, so a plain `.click()` does not open it — fire the
    // pointer pair the trigger expects.
    const kebabLocator = page.getByRole('button', { name: /Canvas actions: sketches\/inbox/i })
    const kebab = (await kebabLocator.element()) as HTMLButtonElement
    fireEvent.pointerDown(kebab, { button: 0 })
    fireEvent.pointerUp(kebab, { button: 0 })
    fireEvent.click(kebab)

    // The Optimize menu item is the only action for now; clicking it must
    // fire the per-canvas compact endpoint with the right slug encoding.
    const optimize = await page.getByRole('menuitem', { name: /optimize/i }).element()
    fireEvent.click(optimize as HTMLElement)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/workspaces/ws_2/canvases/sketches%2Finbox/compact',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('keeps canvas links pointing at the workspace-scoped path so the daemon resolves the right blob', async () => {
    const { container } = render(
      <MemoryRouter>
        <div className="min-h-screen w-[1100px] bg-background p-6">
          <IndexPage />
        </div>
      </MemoryRouter>,
    )

    await expect.element(page.getByRole('link', { name: /sketches\/inbox/i })).toBeInTheDocument()
    const hrefs = Array.from(container.querySelectorAll('a'))
      .map((a) => a.getAttribute('href') ?? '')
      .filter((h) => h.includes('/canvas/'))
    // Internal route shape is preserved even though the UI never names the workspace.
    expect(hrefs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\/canvas\/ws_2\/sketches%2Finbox$/),
        expect.stringMatching(/^\/canvas\/ws_1\/design%2Flogin$/),
        expect.stringMatching(/^\/canvas\/ws_1\/design%2Fold$/),
      ]),
    )
  })
})
