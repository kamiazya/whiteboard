import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import '../index.css'

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const fakeApi = {
  updateLibrary: vi.fn(),
  getSceneElements: () => [],
  getAppState: () => ({}),
  getFiles: () => ({}),
}

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: ({ excalidrawAPI }: { excalidrawAPI?: (api: unknown) => void }) => {
    excalidrawAPI?.(fakeApi)
    return null
  },
  exportToBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  CaptureUpdateAction: { NEVER: 'never' },
  restoreElements: vi.fn(),
}))

vi.mock('../hooks/useWhiteboardSync.js', () => ({
  useWhiteboardSync: () => ({
    onApiReady: vi.fn(),
    onSceneChange: vi.fn(),
    clearLocalUndo: vi.fn(),
    restoreInProgress: false,
    restoreLabel: null,
  }),
}))
vi.mock('../components/WorkspaceTopBar.js', () => ({ default: () => null }))
vi.mock('../components/MergeToast.js', () => ({ MergeToast: () => null }))
vi.mock('../components/MergeHighlight.js', () => ({ MergeHighlight: () => null }))
vi.mock('../components/HeaderBranchBanner.js', () => ({ HeaderBranchBanner: () => null }))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LIBRARY_URL = 'https://example.com/test.excalidrawlib'

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function addLibraryHash(): string {
  return `#addLibrary=${encodeURIComponent(LIBRARY_URL)}`
}

// A minimal v2 excalidrawlib payload — normalizeLibraryPayload returns the
// libraryItems array directly, giving a non-empty result so importLibrary
// returns true and the persist POST fires.
const LIBRARY_PAYLOAD = {
  type: 'excalidrawlib',
  version: 2,
  libraryItems: [{ id: 'item-1', status: 'published', elements: [], created: 1 }],
}

// Per-URL fetch router:
//   - the library URL returns the excalidrawlib payload
//   - the server-registered libraries GET returns an empty list
//   - the POST to persist the library returns 200
//   - the canvases list returns an empty array
function makeRoutedFetch(capturedRequests: Request[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = (init?.method ?? 'GET').toUpperCase()

    // Capture every request so tests can assert on them.
    capturedRequests.push(new Request(url, init))

    if (url === LIBRARY_URL) {
      return new Response(JSON.stringify(LIBRARY_PAYLOAD), { status: 200 })
    }

    const pathname = new URL(url, 'http://localhost').pathname
    if (/^\/api\/workspaces\/[^/]+\/libraries$/.test(pathname)) {
      if (method === 'POST') {
        return new Response(JSON.stringify({}), { status: 200 })
      }
      // GET: return empty installed-library list
      return new Response(JSON.stringify({ urls: [] }), { status: 200 })
    }

    // canvases list and any other endpoints
    return new Response(JSON.stringify({ canvases: [], urls: [] }), { status: 200 })
  })
}

// ---------------------------------------------------------------------------
// Module under test (imported once after all vi.mock calls are hoisted)
// ---------------------------------------------------------------------------

const { default: CanvasPage } = await import('./CanvasPage.js')

const BASE_PATH = '/canvas/sess_1/canvas-a'
const WORKSPACE_ID = 'sess_1'

function renderWithHash(hash: string) {
  // MemoryRouter does not drive window.location, so set the hash directly.
  window.location.hash = hash
  return render(
    <MemoryRouter initialEntries={[`${BASE_PATH}${hash}`]}>
      <Routes>
        <Route path="/canvas/:workspaceId/*" element={<CanvasPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CanvasPage #addLibrary import effect (mcp-browser)', () => {
  let capturedRequests: Request[]

  beforeEach(() => {
    window.location.hash = ''
    capturedRequests = []
    vi.stubGlobal('fetch', makeRoutedFetch(capturedRequests))
    fakeApi.updateLibrary.mockClear()
  })

  afterEach(() => {
    window.location.hash = ''
    vi.unstubAllGlobals()
    cleanup()
    vi.clearAllMocks()
  })

  it('clears the #addLibrary hash via history.replaceState after import', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState')

    try {
      renderWithHash(addLibraryHash())

      await waitFor(() => {
        // The effect clears the hash immediately after reading it.
        const clearCalls = replaceState.mock.calls.filter((call) => {
          const url = call[2]
          return typeof url === 'string' && !url.includes('#addLibrary')
        })
        expect(
          clearCalls.length,
          'replaceState must be called with a URL that has no #addLibrary',
        ).toBeGreaterThan(0)
      })
    } finally {
      replaceState.mockRestore()
    }
  })

  it('calls updateLibrary once with the expected payload', async () => {
    renderWithHash(addLibraryHash())

    await waitFor(() => {
      expect(fakeApi.updateLibrary).toHaveBeenCalledOnce()
    })

    const [callArg] = fakeApi.updateLibrary.mock.calls[0] as [
      Parameters<typeof fakeApi.updateLibrary>[0],
    ]
    // The import opens the library menu for a new #addLibrary import.
    expect(callArg).toMatchObject({
      openLibraryMenu: true,
      merge: true,
    })
    // libraryItems must be the non-empty array from the excalidrawlib payload.
    expect(Array.isArray(callArg.libraryItems)).toBe(true)
    expect((callArg.libraryItems as unknown[]).length).toBeGreaterThan(0)
  })

  it('POSTs to /api/workspaces/:id/libraries to persist the imported URL', async () => {
    await act(async () => {
      renderWithHash(addLibraryHash())
    })

    const isPersistPost = (req: Request) =>
      req.method === 'POST' &&
      new URL(req.url).pathname === `/api/workspaces/${WORKSPACE_ID}/libraries`

    await waitFor(() => {
      const postCalls = capturedRequests.filter(isPersistPost)
      expect(postCalls.length, 'a POST to /libraries must fire after a successful import').toBe(1)
    })

    // The persisted URL must match the one from the hash.
    const postReq = capturedRequests.find(isPersistPost)!
    const body = JSON.parse(await postReq.clone().text()) as { url: string }
    expect(body.url).toBe(LIBRARY_URL)
  })

  it('does NOT call updateLibrary or POST when the library fetch returns no items', async () => {
    // Override fetch so the library URL returns an empty (invalid) payload.
    const emptyFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url === LIBRARY_URL) {
        return new Response(
          JSON.stringify({ type: 'excalidrawlib', version: 2, libraryItems: [] }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ canvases: [], urls: [] }), { status: 200 })
    })
    vi.stubGlobal('fetch', emptyFetch)

    const replaceState = vi.spyOn(window.history, 'replaceState')

    try {
      await act(async () => {
        renderWithHash(addLibraryHash())
      })

      // Allow effects to settle.
      await new Promise((r) => setTimeout(r, 200))

      expect(fakeApi.updateLibrary).not.toHaveBeenCalled()

      const postCalls = emptyFetch.mock.calls.filter((call: unknown[]) => {
        const [, init] = call as [unknown, RequestInit | undefined]
        return (init?.method ?? 'GET').toUpperCase() === 'POST'
      })
      expect(postCalls.length, 'POST must not fire when no library items were imported').toBe(0)

      // replaceState must still fire to clear the hash even when the import yields no items.
      const clearCalls = replaceState.mock.calls.filter((call) => {
        const url = call[2]
        return typeof url === 'string' && !url.includes('#addLibrary')
      })
      expect(
        clearCalls.length,
        'replaceState must clear the hash even when libraryItems is empty',
      ).toBeGreaterThan(0)
    } finally {
      replaceState.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// On-mount GET /libraries restore path
// ---------------------------------------------------------------------------

describe('CanvasPage on-mount library restore (mcp-browser)', () => {
  let capturedRequests: Request[]

  beforeEach(() => {
    window.location.hash = ''
    capturedRequests = []
    fakeApi.updateLibrary.mockClear()
  })

  afterEach(() => {
    window.location.hash = ''
    vi.unstubAllGlobals()
    cleanup()
    vi.clearAllMocks()
  })

  it('fetches GET /api/workspaces/:id/libraries on every mount', async () => {
    vi.stubGlobal('fetch', makeRoutedFetch(capturedRequests))

    await act(async () => {
      renderWithHash('')
    })

    await waitFor(() => {
      const getLibraries = capturedRequests.filter((req) => {
        return (
          req.method === 'GET' &&
          /\/api\/workspaces\/[^/]+\/libraries$/.test(new URL(req.url).pathname)
        )
      })
      expect(
        getLibraries.length,
        'GET /libraries must be called on mount to restore server-registered libraries',
      ).toBeGreaterThan(0)
    })
  })

  it('calls updateLibrary (openLibraryMenu=false) for each server-registered URL', async () => {
    // Return one registered library URL from the GET endpoint, and serve a valid
    // excalidrawlib payload when that URL is fetched.
    const REGISTERED_URL = 'https://example.com/registered.excalidrawlib'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input)
        const method = (init?.method ?? 'GET').toUpperCase()
        capturedRequests.push(new Request(url, init))

        if (url === REGISTERED_URL) {
          return new Response(JSON.stringify(LIBRARY_PAYLOAD), { status: 200 })
        }

        const pathname = new URL(url, 'http://localhost').pathname
        if (/^\/api\/workspaces\/[^/]+\/libraries$/.test(pathname) && method === 'GET') {
          return new Response(JSON.stringify({ urls: [REGISTERED_URL] }), { status: 200 })
        }

        return new Response(JSON.stringify({ canvases: [], urls: [] }), { status: 200 })
      }),
    )

    await act(async () => {
      renderWithHash('')
    })

    await waitFor(() => {
      expect(fakeApi.updateLibrary).toHaveBeenCalled()
    })

    const calls = fakeApi.updateLibrary.mock.calls as Array<
      [Parameters<typeof fakeApi.updateLibrary>[0]]
    >
    // The restore path must NOT open the library panel — openLibraryMenu must be false.
    const restoreCall = calls.find(([arg]) => arg.openLibraryMenu === false)
    expect(
      restoreCall,
      'updateLibrary must be called with openLibraryMenu=false for the on-mount restore',
    ).toBeDefined()
    expect(Array.isArray(restoreCall![0].libraryItems)).toBe(true)
    expect((restoreCall![0].libraryItems as unknown[]).length).toBeGreaterThan(0)
  })

  it('does NOT open the library panel for restored libraries (openLibraryMenu stays false)', async () => {
    const REGISTERED_URL = 'https://example.com/silent.excalidrawlib'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input)
        const method = (init?.method ?? 'GET').toUpperCase()

        if (url === REGISTERED_URL) {
          return new Response(JSON.stringify(LIBRARY_PAYLOAD), { status: 200 })
        }

        const pathname = new URL(url, 'http://localhost').pathname
        if (/^\/api\/workspaces\/[^/]+\/libraries$/.test(pathname) && method === 'GET') {
          return new Response(JSON.stringify({ urls: [REGISTERED_URL] }), { status: 200 })
        }

        return new Response(JSON.stringify({ canvases: [], urls: [] }), { status: 200 })
      }),
    )

    await act(async () => {
      renderWithHash('')
    })

    await waitFor(() => {
      expect(fakeApi.updateLibrary).toHaveBeenCalled()
    })

    // Every updateLibrary call from the restore path must have openLibraryMenu=false.
    const calls = fakeApi.updateLibrary.mock.calls as Array<
      [Parameters<typeof fakeApi.updateLibrary>[0]]
    >
    const badCalls = calls.filter(([arg]) => arg.openLibraryMenu !== false)
    expect(
      badCalls.length,
      'on-mount restore must never open the library panel (openLibraryMenu must always be false)',
    ).toBe(0)
  })
})
