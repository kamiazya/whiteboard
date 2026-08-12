import { resetTokenStoreForTests } from '@kamiazya/whiteboard-mcp/api-client'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App, LazyPageFallback } from './App.js'
import { errorBoundaryLog } from './components/ErrorBoundary.js'
import type { DaemonConnectionResult } from './hooks/useDaemonConnection.js'
// App reaches every page through React.lazy(), so a page renders only once
// its dynamic import resolves. The other three pages are vi.mock'd below, so
// their imports are already trivial; PairConsentPage is the one this file
// loads for real, and under a full-suite run the dev server served that
// chunk slowly enough to outlast the assertion's retry budget. Importing it
// here — before any test runs, with nothing competing — puts it in the ESM
// cache, so lazy() settles in a microtask and the render is deterministic
// rather than a race the assertion usually wins. Side-effect import: the
// component is reached through App, never referenced directly.
import './pages/PairConsentPage.js'
import {
  BROWSER_LOCAL_CAPABILITIES,
  type ProviderState,
  resolveHostedProviderStateFromRaw,
  type WhiteboardCapabilities,
} from './lib/provider.js'
import { createUserSettingsStore, STORAGE_KEY } from './lib/user-settings-store.js'

afterEach(cleanup)

// Records the props BrowserLocalCanvasPage receives so tests can assert
// capabilities actually flow from App down to the page, not just that the
// page mounts. BrowserLocalCanvasPage pulls in loro-crdt, which needs a
// real browser (WASM), so it stays mocked.
let receivedCapabilities: WhiteboardCapabilities | undefined
// Captures the initialCanvasId prop so a test can assert App derives it from
// the /local/:canvasId URL (parseBrowserLocalRoute) rather than merely
// mounting the page.
let receivedInitialCanvasId: string | undefined
// Toggled by the error-boundary test to force the mocked page to throw
// during render, so App's ErrorBoundary wiring has something real to catch.
let throwInBrowserLocalCanvasPage = false
vi.mock('./pages/BrowserLocalCanvasPage.js', () => ({
  BrowserLocalCanvasPage: ({
    capabilities,
    initialCanvasId,
  }: {
    capabilities?: WhiteboardCapabilities
    initialCanvasId?: string
  }) => {
    receivedCapabilities = capabilities
    receivedInitialCanvasId = initialCanvasId
    if (throwInBrowserLocalCanvasPage) {
      throw new Error('boom')
    }
    return <div data-testid="browser-local-canvas-page" />
  },
}))

// Captures the open callback so a test can drive list -> editor navigation
// without rendering the real list (which would pull in the store's IDB path).
let receivedIndexPageOnOpenCanvas: ((id: string) => void) | undefined
vi.mock('./pages/BrowserLocalIndexPage.js', () => ({
  BrowserLocalIndexPage: ({ onOpenCanvas }: { onOpenCanvas: (id: string) => void }) => {
    receivedIndexPageOnOpenCanvas = onOpenCanvas
    return <div data-testid="browser-local-index-page" />
  },
}))

// useDaemonConnection is a module-level singleton (see its own test file for
// why) — mocked here so App routing tests control its result directly
// instead of round-tripping through window.location.hash.
let mockDaemonConnectionResult: DaemonConnectionResult = { status: 'none' }
vi.mock('./hooks/useDaemonConnection.js', () => ({
  useDaemonConnection: () => mockDaemonConnectionResult,
}))

// Silent-renewal seam: everything else in pairing-grant stays real (the
// /pair tests exercise the true fragment/PKCE code paths).
let mockRenewResult: import('./lib/pairing-grant.js').GrantConsumeResult = { status: 'none' }
const renewPairingTokenMock = vi.fn(async () => mockRenewResult)
vi.mock('./lib/pairing-grant.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/pairing-grant.js')>()),
  renewPairingToken: (...args: unknown[]) => renewPairingTokenMock(...(args as [])),
}))

let receivedDaemonPageProps: Record<string, unknown> | undefined
// Toggled by the error-boundary test: throwing from the lazily-resolved page
// exercises the paired branch's boundary, which must sit OUTSIDE Suspense to
// catch errors surfacing through the lazy path.
let throwInDaemonCanvasPage = false
vi.mock('./pages/DaemonCanvasPage.js', () => ({
  DaemonCanvasPage: (props: Record<string, unknown>) => {
    receivedDaemonPageProps = props
    if (throwInDaemonCanvasPage) {
      throw new Error('boom-daemon')
    }
    return <div data-testid="daemon-canvas-page" />
  },
}))

let receivedDaemonIndexPageProps: Record<string, unknown> | undefined
vi.mock('./pages/DaemonIndexPage.js', () => ({
  DaemonIndexPage: (props: Record<string, unknown>) => {
    receivedDaemonIndexPageProps = props
    return <div data-testid="daemon-index-page" />
  },
}))

const BROWSER_LOCAL_STATE: ProviderState = {
  kind: 'browser-local',
  capabilities: {
    canvasReadWrite: true,
    migrationExport: true,
    migrationImport: false,
    workspaces: false,
    versions: false,
    branches: false,
    merge: false,
  },
}

const LOCAL_DAEMON_STATE: ProviderState = {
  kind: 'local-daemon',
  daemonBaseUrl: 'http://127.0.0.1:3000',
  capabilities: {
    canvasReadWrite: true,
    migrationExport: false,
    migrationImport: true,
    workspaces: true,
    versions: true,
    branches: true,
    merge: true,
  },
}

const INVALID_CONFIG_STATE: ProviderState = {
  kind: 'invalid-config',
  message: 'Runtime configuration is invalid.',
}

describe('silent renewal on a hosted origin', () => {
  beforeEach(() => {
    localStorage.clear()
    renewPairingTokenMock.mockClear()
    mockRenewResult = { status: 'none' }
  })

  it('reconnects to the stored daemon without a redirect and renders daemon mode', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        storage: { localDaemonBaseUrl: 'http://127.0.0.1:3099' },
        migration: {},
        capabilities: {},
      }),
    )
    mockRenewResult = { status: 'paired', daemonBaseUrl: 'http://127.0.0.1:3099', token: 'tok-r' }
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App providerState={BROWSER_LOCAL_STATE} />
        </MemoryRouter>,
      )
    })

    await screen.findByTestId('daemon-index-page')
    expect(renewPairingTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ daemonBaseUrl: 'http://127.0.0.1:3099' }),
    )
    expect(receivedDaemonIndexPageProps).toMatchObject({
      daemonBaseUrl: 'http://127.0.0.1:3099',
      token: 'tok-r',
    })
  })

  it('falls back to browser-local when renewal reports none (revoked / unreachable)', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        storage: { localDaemonBaseUrl: 'http://127.0.0.1:3099' },
        migration: {},
        capabilities: {},
      }),
    )
    mockRenewResult = { status: 'none' }
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App providerState={BROWSER_LOCAL_STATE} />
        </MemoryRouter>,
      )
    })

    await screen.findByTestId('browser-local-index-page')
    expect(screen.queryByTestId('daemon-index-page')).toBeNull()
  })

  it('surfaces the identity-mismatch warning when renewal fails closed', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        storage: { localDaemonBaseUrl: 'http://127.0.0.1:3099' },
        migration: {},
        capabilities: {},
      }),
    )
    mockRenewResult = { status: 'identity-mismatch', daemonBaseUrl: 'http://127.0.0.1:3099' }
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App providerState={BROWSER_LOCAL_STATE} />
        </MemoryRouter>,
      )
    })

    // Fail closed: stays on browser-local AND tells the user why.
    await screen.findByTestId('browser-local-index-page')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/identity changed/i)
  })

  it('does not attempt renewal when no daemon was ever stored', async () => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App providerState={BROWSER_LOCAL_STATE} />
        </MemoryRouter>,
      )
    })

    await screen.findByTestId('browser-local-index-page')
    expect(renewPairingTokenMock).not.toHaveBeenCalled()
  })
})

describe('grant exchange failure surfacing', () => {
  it('a failed #wb-grant exchange shows an alert instead of silently falling back', async () => {
    // No pairing transaction in sessionStorage -> the real consumeGrantFragment
    // deterministically resolves { status: 'error' }. The user just clicked
    // Approve on the daemon's consent page; browser-local with zero feedback
    // is the dead end this notice exists to close.
    sessionStorage.clear()
    window.location.hash = '#wb-grant=abc&state=xyz'
    try {
      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/']}>
            <App providerState={BROWSER_LOCAL_STATE} />
          </MemoryRouter>,
        )
      })

      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toMatch(/pairing didn't complete/i)
      // Dismissible: the notice must not permanently occupy the banner row.
      fireEvent.click(screen.getByRole('button', { name: /dismiss pairing error/i }))
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      window.location.hash = ''
    }
  })
})

describe('/pair consent route', () => {
  it('renders the consent page and does NOT rewrite the URL away from /pair', async () => {
    // Regression: the daemonView -> URL sync effect ran on mount, saw
    // parseDaemonRoute('/pair') === null (so daemonView defaulted to the
    // index), and navigated to '/' — dropping the origin/challenge/state
    // query and dumping the user on the daemon gallery instead of the
    // consent page. Observed live on the daemon origin, 2026-08-07.
    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: <App providerState={LOCAL_DAEMON_STATE} />,
        },
      ],
      {
        initialEntries: ['/pair?origin=https%3A%2F%2Fexample.com&challenge=chal&state=st'],
      },
    )
    await act(async () => {
      render(<RouterProvider router={router} />)
    })

    expect(router.state.location.pathname).toBe('/pair')
    const search = new URLSearchParams(router.state.location.search)
    expect(search.get('origin')).toBe('https://example.com')
    expect(search.get('challenge')).toBe('chal')
    expect(search.get('state')).toBe('st')
    // Synchronous on purpose: the page module is preloaded at the top of this
    // file, so nothing here waits on a chunk. If that preload is ever dropped
    // this fails immediately instead of flaking under load.
    screen.getByText(/allow this web app to use your local daemon/i)
    expect(screen.queryByText(/Configured for local daemon/)).toBeNull()
  })
})

describe('App backend configuration chip', () => {
  it('renders no fixed backend-config overlay (D1: the header connection chip owns this)', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    expect(screen.queryByTestId('backend-config-chip')).toBeNull()
    expect(screen.queryByText('Browser only')).toBeNull()
  })

  it('renders no daemon-URL overlay when configured for a local daemon', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={LOCAL_DAEMON_STATE} />
      </MemoryRouter>,
    )
    expect(screen.queryByTestId('backend-config-chip')).toBeNull()
    expect(screen.queryByText(/Configured for local daemon/)).toBeNull()
  })

  it('does not render the chip on the invalid-config error page', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={INVALID_CONFIG_STATE} />
      </MemoryRouter>,
    )
    expect(screen.queryByText('Browser only')).toBeNull()
    expect(screen.queryByText(/Configured for local daemon/)).toBeNull()
  })

  it('renders the custom-domain-unsupported guidance without echoing the rejected origin', () => {
    const state = resolveHostedProviderStateFromRaw({
      publicOrigin: 'https://custom.example.com',
    })
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={state} />
      </MemoryRouter>,
    )
    expect(screen.getByText(/custom domain/i)).toBeTruthy()
    expect(screen.queryByText(/custom\.example\.com/)).toBeNull()
    expect(document.body.textContent).not.toMatch(/https?:\/\//)
  })

  it('lets the browser-local escape override invalid-config after a failed pairing', async () => {
    // A pairing error can coexist with an invalid runtime config; clicking
    // "Continue in browser-local" must land on the browser-local page, not
    // bounce the user onto the invalid-config error page.
    mockDaemonConnectionResult = { status: 'error', detail: 'malformed fragment' }
    try {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App providerState={INVALID_CONFIG_STATE} />
        </MemoryRouter>,
      )
      fireEvent.click(screen.getByRole('button', { name: /continue in browser-local/i }))
      expect(await screen.findByTestId('browser-local-index-page')).toBeTruthy()
      expect(screen.queryByText('Runtime configuration is invalid.')).toBeNull()
    } finally {
      mockDaemonConnectionResult = { status: 'none' }
    }
  })
})

describe('App capability wiring', () => {
  beforeEach(() => {
    receivedCapabilities = undefined
  })

  it('passes the browser-local capabilities down to BrowserLocalCanvasPage', async () => {
    render(
      <MemoryRouter initialEntries={['/local/c1']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('browser-local-canvas-page')
    expect(receivedCapabilities).toEqual(BROWSER_LOCAL_STATE.capabilities)
  })

  it('derives initialCanvasId from a /local/:canvasId cold-load URL', async () => {
    receivedInitialCanvasId = undefined
    render(
      <MemoryRouter initialEntries={['/local/c2']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('browser-local-canvas-page')
    expect(receivedInitialCanvasId).toBe('c2')
  })

  it('lands a plain "/" cold load on the canvas list, not the editor', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('browser-local-index-page')).toBeTruthy()
    expect(screen.queryByTestId('browser-local-canvas-page')).toBeNull()
  })

  it('opening a canvas from the list mounts the editor on that canvas', async () => {
    receivedInitialCanvasId = undefined
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('browser-local-index-page')
    expect(receivedIndexPageOnOpenCanvas).toBeDefined()
    act(() => receivedIndexPageOnOpenCanvas?.('c9'))
    expect(await screen.findByTestId('browser-local-canvas-page')).toBeTruthy()
    expect(receivedInitialCanvasId).toBe('c9')
  })
})

describe('App beta banner', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('shows the browser-only persistence copy for the browser-local state', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    expect(
      screen.getByText('Beta preview — your data is stored only in this browser.'),
    ).toBeTruthy()
  })

  it('shows daemon-neutral copy for the local-daemon state (no browser-only claim)', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={LOCAL_DAEMON_STATE} />
      </MemoryRouter>,
    )
    expect(screen.getByText('Beta preview — features may be incomplete.')).toBeTruthy()
    expect(
      screen.queryByText('Beta preview — your data is stored only in this browser.'),
    ).toBeNull()
  })

  it('does not show the beta banner on the invalid-config error page', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={INVALID_CONFIG_STATE} />
      </MemoryRouter>,
    )
    expect(screen.queryByText(/Beta preview/)).toBeNull()
  })
})

describe('App daemon-pairing routing', () => {
  beforeEach(() => {
    mockDaemonConnectionResult = { status: 'none' }
    receivedDaemonPageProps = undefined
  })

  it('renders DaemonCanvasPage from the payload when paired', async () => {
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: 'w1',
        slug: 'main',
        authMode: 'bootstrap',
        bootstrapToken: 'tok',
      },
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    // DaemonCanvasPage is React.lazy — resolves after a microtask even with
    // a mocked module, so the assertion must await past the Suspense fallback.
    expect(await screen.findByTestId('daemon-canvas-page')).toBeTruthy()
    expect(screen.queryByTestId('browser-local-canvas-page')).toBeNull()
    expect(receivedDaemonPageProps?.daemonBaseUrl).toBe('http://127.0.0.1:3099')
    expect(receivedDaemonPageProps?.workspaceId).toBe('w1')
    expect(receivedDaemonPageProps?.slug).toBe('main')
    expect(receivedDaemonPageProps?.token).toBe('tok')
  })

  it('renders a role=alert error UI with a browser-local escape hatch on error', async () => {
    mockDaemonConnectionResult = { status: 'error', detail: 'malformed fragment' }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()
    const button = screen.getByRole('button', { name: /continue in browser-local/i })
    expect(button).toBeTruthy()
    fireEvent.click(button)
    expect(await screen.findByTestId('browser-local-index-page')).toBeTruthy()
  })

  it('falls through to existing provider-state resolution unchanged when there is no fragment', async () => {
    mockDaemonConnectionResult = { status: 'none' }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('browser-local-index-page')).toBeTruthy()
    expect(screen.queryByTestId('daemon-canvas-page')).toBeNull()
  })
})

describe('App reconnect-target persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    mockDaemonConnectionResult = { status: 'none' }
  })
  afterEach(() => {
    mockDaemonConnectionResult = { status: 'none' }
  })

  it('persists baseUrl/workspaceId/slug to user settings on a successful #wb= pairing', async () => {
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: 'w1',
        slug: 'main',
        authMode: 'bootstrap',
        bootstrapToken: 'tok',
      },
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-canvas-page')

    const saved = createUserSettingsStore().load()
    expect(saved.storage.localDaemonBaseUrl).toBe('http://127.0.0.1:3099')
    expect(saved.storage.lastConnectedWorkspaceId).toBe('w1')
    expect(saved.storage.lastConnectedSlug).toBe('main')
  })

  it('never persists the bootstrapToken alongside the connection target', async () => {
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: 'w1',
        slug: 'main',
        authMode: 'bootstrap',
        bootstrapToken: 'super-secret-token',
      },
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-canvas-page')

    expect(localStorage.getItem(STORAGE_KEY) ?? '').not.toContain('super-secret-token')
  })

  it('does not persist a target when there is no #wb= pairing (plain browser-local session)', () => {
    mockDaemonConnectionResult = { status: 'none' }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    expect(createUserSettingsStore().load().storage.localDaemonBaseUrl).toBeUndefined()
  })
})

describe('App local-daemon provider state', () => {
  beforeEach(() => {
    receivedDaemonPageProps = undefined
    receivedDaemonIndexPageProps = undefined
    resetTokenStoreForTests()
    delete (window as { __WHITEBOARD_DAEMON_TOKEN__?: unknown }).__WHITEBOARD_DAEMON_TOKEN__
  })
  afterEach(() => {
    resetTokenStoreForTests()
    delete (window as { __WHITEBOARD_DAEMON_TOKEN__?: unknown }).__WHITEBOARD_DAEMON_TOKEN__
  })

  it('mounts DaemonIndexPage (the gallery) instead of auto-opening a canvas', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={LOCAL_DAEMON_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('daemon-index-page')).toBeTruthy()
    expect(screen.queryByTestId('daemon-canvas-page')).toBeNull()
    expect(screen.queryByTestId('browser-local-canvas-page')).toBeNull()
    expect(screen.queryByText('Whiteboard')).toBeNull()
    expect(receivedDaemonIndexPageProps?.daemonBaseUrl).toBe(LOCAL_DAEMON_STATE.daemonBaseUrl)
    expect(receivedDaemonIndexPageProps?.onOpenCanvas).toBeInstanceOf(Function)
  })

  it('mounts DaemonCanvasPage with the opened canvas identity after a gallery selection', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={LOCAL_DAEMON_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-index-page')
    const onOpenCanvas = receivedDaemonIndexPageProps?.onOpenCanvas as (
      workspaceId: string,
      slug: string,
    ) => void
    act(() => {
      onOpenCanvas('w1', 'main')
    })
    expect(await screen.findByTestId('daemon-canvas-page')).toBeTruthy()
    expect(screen.queryByTestId('daemon-index-page')).toBeNull()
    expect(receivedDaemonPageProps?.workspaceId).toBe('w1')
    expect(receivedDaemonPageProps?.slug).toBe('main')
    expect(receivedDaemonPageProps?.capabilities).toEqual(LOCAL_DAEMON_STATE.capabilities)
    expect(receivedDaemonPageProps?.browserLocalStore).toBeDefined()
    expect(receivedDaemonPageProps?.onContinueBrowserLocal).toBeInstanceOf(Function)
    expect(receivedDaemonPageProps?.onNavigateBack).toBeInstanceOf(Function)
  })

  it('passes the daemon-injected token when present', async () => {
    ;(window as { __WHITEBOARD_DAEMON_TOKEN__?: unknown }).__WHITEBOARD_DAEMON_TOKEN__ = 'tok-x'
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={LOCAL_DAEMON_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('daemon-index-page')).toBeTruthy()
    expect(receivedDaemonIndexPageProps?.token).toBe('tok-x')
  })

  it('mounts gracefully with token undefined when the daemon has not injected one', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={LOCAL_DAEMON_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('daemon-index-page')).toBeTruthy()
    expect(receivedDaemonIndexPageProps?.token).toBeUndefined()
  })

  it('returns to the index when DaemonCanvasPage invokes onNavigateBack', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={LOCAL_DAEMON_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-index-page')
    act(() => {
      const onOpenCanvas = receivedDaemonIndexPageProps?.onOpenCanvas as (
        workspaceId: string,
        slug: string,
      ) => void
      onOpenCanvas('w1', 'main')
    })
    await screen.findByTestId('daemon-canvas-page')
    const onNavigateBack = receivedDaemonPageProps?.onNavigateBack as () => void
    act(() => {
      onNavigateBack()
    })
    expect(await screen.findByTestId('daemon-index-page')).toBeTruthy()
    expect(screen.queryByTestId('daemon-canvas-page')).toBeNull()
  })

  it('preserves the opened canvas workspaceId as initialWorkspaceId when navigating back to the index', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={LOCAL_DAEMON_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-index-page')
    act(() => {
      const onOpenCanvas = receivedDaemonIndexPageProps?.onOpenCanvas as (
        workspaceId: string,
        slug: string,
      ) => void
      onOpenCanvas('workspace-b', 'main')
    })
    await screen.findByTestId('daemon-canvas-page')
    const onNavigateBack = receivedDaemonPageProps?.onNavigateBack as () => void
    act(() => {
      onNavigateBack()
    })
    await screen.findByTestId('daemon-index-page')
    expect(receivedDaemonIndexPageProps?.initialWorkspaceId).toBe('workspace-b')
  })

  it('remounts DaemonCanvasPage cleanly when opening a different canvas after returning to the index', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={LOCAL_DAEMON_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-index-page')
    act(() => {
      const onOpenCanvas = receivedDaemonIndexPageProps?.onOpenCanvas as (
        workspaceId: string,
        slug: string,
      ) => void
      onOpenCanvas('w1', 'canvas-a')
    })
    await screen.findByTestId('daemon-canvas-page')
    expect(receivedDaemonPageProps?.slug).toBe('canvas-a')

    const onNavigateBack = receivedDaemonPageProps?.onNavigateBack as () => void
    act(() => {
      onNavigateBack()
    })
    await screen.findByTestId('daemon-index-page')

    act(() => {
      const onOpenCanvas = receivedDaemonIndexPageProps?.onOpenCanvas as (
        workspaceId: string,
        slug: string,
      ) => void
      onOpenCanvas('w1', 'canvas-b')
    })
    await screen.findByTestId('daemon-canvas-page')
    expect(receivedDaemonPageProps?.slug).toBe('canvas-b')
  })

  it('escapes to browser-local with BROWSER_LOCAL_CAPABILITIES and neutral banner copy', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={LOCAL_DAEMON_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-index-page')
    act(() => {
      const onOpenCanvas = receivedDaemonIndexPageProps?.onOpenCanvas as (
        workspaceId: string,
        slug: string,
      ) => void
      onOpenCanvas('w1', 'main')
    })
    await screen.findByTestId('daemon-canvas-page')
    const onContinueBrowserLocal = receivedDaemonPageProps?.onContinueBrowserLocal as () => void
    act(() => {
      onContinueBrowserLocal()
    })
    expect(await screen.findByTestId('browser-local-index-page')).toBeTruthy()
    expect(screen.queryByTestId('daemon-canvas-page')).toBeNull()
    // Capabilities flow to the editor: open a canvas from the escaped list.
    act(() => receivedIndexPageOnOpenCanvas?.('c1'))
    await screen.findByTestId('browser-local-canvas-page')
    expect(receivedCapabilities).toEqual(BROWSER_LOCAL_CAPABILITIES)
    expect(screen.queryByText(/Configured for local daemon/)).toBeNull()
    expect(
      screen.getByText('Beta preview — your data is stored only in this browser.'),
    ).toBeTruthy()
    expect(screen.queryByText('Beta preview — features may be incomplete.')).toBeNull()
  })

  it('catches an error surfacing through the local-daemon lazy path (boundary outside Suspense)', async () => {
    throwInDaemonCanvasPage = true
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={LOCAL_DAEMON_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-index-page')
    const reportSpy = vi.spyOn(errorBoundaryLog, 'report').mockImplementation(() => {})
    try {
      act(() => {
        const onOpenCanvas = receivedDaemonIndexPageProps?.onOpenCanvas as (
          workspaceId: string,
          slug: string,
        ) => void
        onOpenCanvas('w1', 'main')
      })
      expect(await screen.findByText('Something went wrong')).toBeTruthy()
      expect(reportSpy).toHaveBeenCalled()
    } finally {
      throwInDaemonCanvasPage = false
      reportSpy.mockRestore()
    }
  })
})

describe('App daemon-pairing routing (index vs canvas)', () => {
  beforeEach(() => {
    receivedDaemonPageProps = undefined
    receivedDaemonIndexPageProps = undefined
    mockDaemonConnectionResult = { status: 'none' }
  })
  afterEach(() => {
    mockDaemonConnectionResult = { status: 'none' }
  })

  it('lands on the index when the #wb= payload has no slug', async () => {
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: undefined,
        slug: undefined,
        authMode: 'bootstrap',
        bootstrapToken: 'tok',
      },
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('daemon-index-page')).toBeTruthy()
    expect(screen.queryByTestId('daemon-canvas-page')).toBeNull()
  })

  it('forwards the payload workspaceId as initialWorkspaceId when the #wb= payload has a workspace but no slug', async () => {
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: 'workspace-b',
        slug: undefined,
        authMode: 'bootstrap',
        bootstrapToken: 'tok',
      },
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('daemon-index-page')).toBeTruthy()
    expect(receivedDaemonIndexPageProps?.initialWorkspaceId).toBe('workspace-b')
  })
})

// Exposes the current router location as text so tests can assert on the
// address bar without reaching into react-router internals.
function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location-probe">{location.pathname}</div>
}

// createMemoryRouter (rather than a plain <MemoryRouter>) exposes an
// imperative `navigate(-1)`/`navigate(1)`, which is the only way to
// simulate the browser back/forward buttons in a router that has no real
// browser history to click through.
function renderAppWithRouter(providerState: ProviderState, initialPath = '/') {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <>
            <App providerState={providerState} />
            <LocationProbe />
          </>
        ),
      },
    ],
    { initialEntries: [initialPath] },
  )
  render(<RouterProvider router={router} />)
  return router
}

describe('App URL routing', () => {
  beforeEach(() => {
    receivedDaemonPageProps = undefined
    receivedDaemonIndexPageProps = undefined
    mockDaemonConnectionResult = { status: 'none' }
  })
  afterEach(() => {
    mockDaemonConnectionResult = { status: 'none' }
  })

  it('cold-loads a /canvas/:workspaceId/:slug deep link straight into DaemonCanvasPage', async () => {
    renderAppWithRouter(LOCAL_DAEMON_STATE, '/canvas/w1/main')
    expect(await screen.findByTestId('daemon-canvas-page')).toBeTruthy()
    expect(receivedDaemonPageProps?.workspaceId).toBe('w1')
    expect(receivedDaemonPageProps?.slug).toBe('main')
  })

  it('cold-loads a /w/:workspaceId deep link into the gallery pre-scoped to that workspace', async () => {
    renderAppWithRouter(LOCAL_DAEMON_STATE, '/w/workspace-b')
    expect(await screen.findByTestId('daemon-index-page')).toBeTruthy()
    expect(receivedDaemonIndexPageProps?.initialWorkspaceId).toBe('workspace-b')
  })

  it('updates the URL when in-app navigation opens a canvas from the gallery', async () => {
    const router = renderAppWithRouter(LOCAL_DAEMON_STATE, '/')
    await screen.findByTestId('daemon-index-page')
    act(() => {
      const onOpenCanvas = receivedDaemonIndexPageProps?.onOpenCanvas as (
        workspaceId: string,
        slug: string,
      ) => void
      onOpenCanvas('w1', 'main')
    })
    await screen.findByTestId('daemon-canvas-page')
    expect(router.state.location.pathname).toBe('/canvas/w1/main')
  })

  it('updates the URL back to the gallery when onNavigateBack fires', async () => {
    const router = renderAppWithRouter(LOCAL_DAEMON_STATE, '/canvas/w1/main')
    await screen.findByTestId('daemon-canvas-page')
    const onNavigateBack = receivedDaemonPageProps?.onNavigateBack as () => void
    act(() => {
      onNavigateBack()
    })
    await screen.findByTestId('daemon-index-page')
    expect(router.state.location.pathname).toBe('/w/w1')
  })

  it('responds to browser back/forward by updating the rendered view', async () => {
    const router = renderAppWithRouter(LOCAL_DAEMON_STATE, '/')
    await screen.findByTestId('daemon-index-page')
    act(() => {
      const onOpenCanvas = receivedDaemonIndexPageProps?.onOpenCanvas as (
        workspaceId: string,
        slug: string,
      ) => void
      onOpenCanvas('w1', 'main')
    })
    await screen.findByTestId('daemon-canvas-page')

    act(() => {
      router.navigate(-1)
    })
    expect(await screen.findByTestId('daemon-index-page')).toBeTruthy()
    expect(screen.queryByTestId('daemon-canvas-page')).toBeNull()

    act(() => {
      router.navigate(1)
    })
    expect(await screen.findByTestId('daemon-canvas-page')).toBeTruthy()
  })

  it('replaces a consumed #wb= pairing with the canonical URL instead of leaving the raw fragment behind', async () => {
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: 'w1',
        slug: 'main',
        authMode: 'bootstrap',
        bootstrapToken: 'tok',
      },
    }
    const router = renderAppWithRouter(BROWSER_LOCAL_STATE, '/')
    await screen.findByTestId('daemon-canvas-page')
    expect(router.state.location.pathname).toBe('/canvas/w1/main')
    // The replace must not have added a new history entry: going back from
    // here should leave the SPA (nothing left to land on inside this test's
    // single-entry history), not bounce to a stale pre-pairing '/' entry.
    expect(router.state.location.key).not.toBe('default')
  })

  it('shows the not-found page for an unrecognized path (no blank page, no silent redirect)', async () => {
    renderAppWithRouter(LOCAL_DAEMON_STATE, '/something/unrelated/entirely')
    expect(await screen.findByRole('button', { name: /back to canvases/i })).toBeTruthy()
    expect(screen.queryByTestId('daemon-index-page')).toBeNull()
  })
})

describe('App error boundary', () => {
  beforeEach(() => {
    throwInBrowserLocalCanvasPage = false
  })
  afterEach(() => {
    throwInBrowserLocalCanvasPage = false
  })

  it('catches a render error from the active page and shows the fallback instead of crashing the app', async () => {
    throwInBrowserLocalCanvasPage = true
    const reportSpy = vi.spyOn(errorBoundaryLog, 'report').mockImplementation(() => {})
    render(
      <MemoryRouter initialEntries={['/local/c1']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Something went wrong')).toBeTruthy()
    expect(reportSpy).toHaveBeenCalled()
    reportSpy.mockRestore()
  })

  it('catches an error surfacing through the paired branch lazy path (boundary sits outside Suspense)', async () => {
    throwInDaemonCanvasPage = true
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: 'w1',
        slug: 'main',
        authMode: 'bootstrap',
        bootstrapToken: 'tok',
      },
    }
    const reportSpy = vi.spyOn(errorBoundaryLog, 'report').mockImplementation(() => {})
    try {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App providerState={BROWSER_LOCAL_STATE} />
        </MemoryRouter>,
      )
      // The lazy module resolves after a microtask; the throw then propagates
      // through Suspense's error path to the boundary outside it.
      expect(await screen.findByText('Something went wrong')).toBeTruthy()
      expect(reportSpy).toHaveBeenCalled()
    } finally {
      throwInDaemonCanvasPage = false
      mockDaemonConnectionResult = { status: 'none' }
      reportSpy.mockRestore()
    }
  })
})

describe('lazy page fallback', () => {
  // Suspense commits this before a lazy page chunk resolves, so this IS the
  // loading state: the structural page skeleton (pulsing header + canvas
  // placeholders), not a bare line of centered text. Tested directly —
  // through <App> the lazy chunks resolve once per module, so only the
  // file's first render could ever observe the fallback.
  it('renders the structural page skeleton with the message as its label', () => {
    const { container } = render(<LazyPageFallback heightClass="h-full" message="Loading…" />)
    expect(screen.getByLabelText('Loading…')).toBeTruthy()
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
  })
})

describe('App not-found route', () => {
  it('shows the not-found page for a path outside the closed route set', async () => {
    render(
      <MemoryRouter initialEntries={['/definitely/not/a/route']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    // The page chunk is lazy — wait for it to resolve.
    expect(await screen.findByRole('button', { name: /back to canvases/i })).toBeTruthy()
    expect(document.querySelector('[data-mark="not-found"]')).toBeTruthy()
  })

  it('keeps known routes on their normal pages', () => {
    render(
      <MemoryRouter initialEntries={['/local/c9']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    expect(document.querySelector('[data-mark="not-found"]')).toBeNull()
  })
})
