import { resetTokenStoreForTests } from '@kamiazya/whiteboard-mcp/api-client'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App, LazyPageFallback } from './App.js'
import { errorBoundaryLog } from './components/ErrorBoundary.js'
import type { DaemonConnectionResult } from './hooks/useDaemonConnection.js'
import { getBrowserWorkspaceId } from './lib/browser-workspace-id.js'
import { resetShellStatusForTests, setShellConnection } from './lib/shell-status-store.js'
// App reaches every page through React.lazy(), so a page renders only once its
// dynamic import resolves — and under a full-suite run that resolution can
// outlast the 1000ms retry budget of the `findBy*` query waiting on it. The
// rule, enforced by App.lazy-coverage.test.ts rather than by remembering:
// EVERY page App lazy-loads is either vi.mock'd below or imported here, so
// lazy() settles in a microtask and the render is deterministic instead of a
// race the assertion usually wins. Side-effect imports: the components are
// reached through App, never referenced directly.
//
// The earlier version of this comment said "the other three pages are
// vi.mock'd", and NotFoundPage was added afterwards as a fourth that was
// neither mocked nor imported — which is exactly the flake this file kept
// producing in CI and never in isolation. A count goes stale; the guard does
// not.
import './components/status/NotFoundPage.js'
import './pages/PairConsentPage.js'
import {
  BROWSER_CAPABILITIES,
  type ProviderState,
  resolveHostedProviderStateFromRaw,
  type WhiteboardCapabilities,
} from './lib/provider.js'
import { createUserSettingsStore, STORAGE_KEY } from './lib/user-settings-store.js'

afterEach(() => {
  cleanup()
  // File-wide: several tests publish a shell connection to drive the chip,
  // and a leftover sync-off lights the settings nudge for whichever test
  // runs next.
  resetShellStatusForTests()
})

// Records the props BrowserDocumentPage receives so tests can assert
// capabilities actually flow from App down to the page, not just that the
// page mounts. BrowserDocumentPage pulls in loro-crdt, which needs a
// real browser (WASM), so it stays mocked.
let receivedCapabilities: WhiteboardCapabilities | undefined
// Captures the initialPath prop so a test can assert App derives it from
// the /w/:workspace/d/:path URL (parseBrowserRoute) rather than merely
// mounting the page.
let receivedInitialPath: string | undefined
// Toggled by the error-boundary test to force the mocked page to throw
// during render, so App's ErrorBoundary wiring has something real to catch.
let throwInBrowserDocumentPage = false
vi.mock('./pages/BrowserDocumentPage.js', () => ({
  BrowserDocumentPage: ({
    capabilities,
    initialPath,
  }: {
    capabilities?: WhiteboardCapabilities
    initialPath?: string
  }) => {
    receivedCapabilities = capabilities
    receivedInitialPath = initialPath
    if (throwInBrowserDocumentPage) {
      throw new Error('boom')
    }
    return <div data-testid="browser-document-page" />
  },
}))

// Captures the open callback so a test can drive list -> editor navigation
// without rendering the real list (which would pull in the store's IDB path).
let receivedIndexPageOnOpenCanvas: ((path: string) => void) | undefined
vi.mock('./pages/BrowserIndexPage.js', () => ({
  BrowserIndexPage: ({ onOpenDocument }: { onOpenDocument: (path: string) => void }) => {
    receivedIndexPageOnOpenCanvas = onOpenDocument
    return <div data-testid="browser-index-page" />
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
let throwInDaemonDocumentPage = false
vi.mock('./pages/DaemonDocumentPage.js', () => ({
  DaemonDocumentPage: (props: Record<string, unknown>) => {
    receivedDaemonPageProps = props
    if (throwInDaemonDocumentPage) {
      throw new Error('boom-daemon')
    }
    return <div data-testid="daemon-document-page" />
  },
}))

// Captures the daemon prop so a test can assert App resolves it from the
// active connection (paired fragment / daemon provider state) rather
// than merely mounting the page on the /settings route.
let receivedSettingsPageProps: Record<string, unknown> | undefined
vi.mock('./pages/SettingsPage.js', () => ({
  SettingsPage: (props: Record<string, unknown>) => {
    receivedSettingsPageProps = props
    return <div data-testid="settings-page" />
  },
}))

let receivedDaemonIndexPageProps: Record<string, unknown> | undefined
vi.mock('./pages/DaemonIndexPage.js', () => ({
  DaemonIndexPage: (props: Record<string, unknown>) => {
    receivedDaemonIndexPageProps = props
    return <div data-testid="daemon-index-page" />
  },
}))

const BROWSER_STATE: ProviderState = {
  kind: 'browser',
  capabilities: {
    workspaces: false,
    versions: false,
    branches: false,
    merge: false,
  },
}

const DAEMON_STATE: ProviderState = {
  kind: 'daemon',
  daemonBaseUrl: 'http://127.0.0.1:3000',
  capabilities: {
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
    resetShellStatusForTests()
    localStorage.clear()
    renewPairingTokenMock.mockClear()
    mockRenewResult = { status: 'none' }
  })

  it('reconnects to the stored daemon without a redirect and renders daemon mode', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        storage: { daemonBaseUrl: 'http://127.0.0.1:3099' },
        migration: {},
        capabilities: {},
      }),
    )
    mockRenewResult = { status: 'paired', daemonBaseUrl: 'http://127.0.0.1:3099', token: 'tok-r' }
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App providerState={BROWSER_STATE} />
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

  it('falls back to the browser when renewal reports none (revoked / unreachable)', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        storage: { daemonBaseUrl: 'http://127.0.0.1:3099' },
        migration: {},
        capabilities: {},
      }),
    )
    mockRenewResult = { status: 'none' }
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App providerState={BROWSER_STATE} />
        </MemoryRouter>,
      )
    })

    await screen.findByTestId('browser-index-page')
    expect(screen.queryByTestId('daemon-index-page')).toBeNull()
  })

  it('surfaces the identity-mismatch warning when renewal fails closed', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        storage: { daemonBaseUrl: 'http://127.0.0.1:3099' },
        migration: {},
        capabilities: {},
      }),
    )
    mockRenewResult = { status: 'identity-mismatch', daemonBaseUrl: 'http://127.0.0.1:3099' }
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App providerState={BROWSER_STATE} />
        </MemoryRouter>,
      )
    })

    // Fail closed: stays on the browser AND tells the user why.
    await screen.findByTestId('browser-index-page')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/identity changed/i)
  })

  it('does not attempt renewal when no daemon was ever stored', async () => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App providerState={BROWSER_STATE} />
        </MemoryRouter>,
      )
    })

    await screen.findByTestId('browser-index-page')
    expect(renewPairingTokenMock).not.toHaveBeenCalled()
  })
})

describe('grant exchange failure surfacing', () => {
  it('a failed #wb-grant exchange shows an alert instead of silently falling back', async () => {
    // No pairing transaction in sessionStorage -> the real consumeGrantFragment
    // deterministically resolves { status: 'error' }. The user just clicked
    // Approve on the daemon's consent page; falling back to the browser with zero feedback
    // is the dead end this notice exists to close.
    sessionStorage.clear()
    window.location.hash = '#wb-grant=abc&state=xyz'
    try {
      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/']}>
            <App providerState={BROWSER_STATE} />
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
          element: <App providerState={DAEMON_STATE} />,
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
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    expect(screen.queryByTestId('backend-config-chip')).toBeNull()
    expect(screen.queryByText('Browser only')).toBeNull()
  })

  it('renders no daemon-URL overlay when configured for a local daemon', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={DAEMON_STATE} />
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

  it('lets the escape to the browser override invalid-config after a failed pairing', async () => {
    // A pairing error can coexist with an invalid runtime config; clicking
    // "Work in this browser instead" must land on the browser page, not
    // bounce the user onto the invalid-config error page.
    mockDaemonConnectionResult = { status: 'error', detail: 'malformed fragment' }
    try {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App providerState={INVALID_CONFIG_STATE} />
        </MemoryRouter>,
      )
      fireEvent.click(screen.getByRole('button', { name: /work in this browser instead/i }))
      expect(await screen.findByTestId('browser-index-page')).toBeTruthy()
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

  it('passes the browser capabilities down to BrowserDocumentPage', async () => {
    render(
      <MemoryRouter initialEntries={['/w/default/d/c1']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('browser-document-page')
    expect(receivedCapabilities).toEqual(BROWSER_STATE.capabilities)
  })

  it('derives initialPath from a /w/:workspace/d/:path cold-load URL, folders and all', async () => {
    receivedInitialPath = undefined
    render(
      <MemoryRouter initialEntries={['/w/default/d/design/login%20flow']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('browser-document-page')
    // A path has segments and may be percent-encoded; an id never is, so a
    // single-segment fixture could not tell the two readings apart.
    expect(receivedInitialPath).toBe('design/login flow')
  })

  it('lands a plain "/" cold load on the canvas list, not the editor', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('browser-index-page')).toBeTruthy()
    expect(screen.queryByTestId('browser-document-page')).toBeNull()
  })

  it('opening a canvas from the list mounts the editor on that canvas', async () => {
    receivedInitialPath = undefined
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('browser-index-page')
    expect(receivedIndexPageOnOpenCanvas).toBeDefined()
    act(() => receivedIndexPageOnOpenCanvas?.('notes/c9'))
    expect(await screen.findByTestId('browser-document-page')).toBeTruthy()
    expect(receivedInitialPath).toBe('notes/c9')
  })
})

describe('App daemon-pairing routing', () => {
  beforeEach(() => {
    mockDaemonConnectionResult = { status: 'none' }
    receivedDaemonPageProps = undefined
  })

  it('renders DaemonDocumentPage from the payload when paired', async () => {
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: 'w1',
        path: 'main',
        authMode: 'bootstrap',
        bootstrapToken: 'tok',
      },
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    // DaemonDocumentPage is React.lazy — resolves after a microtask even with
    // a mocked module, so the assertion must await past the Suspense fallback.
    expect(await screen.findByTestId('daemon-document-page')).toBeTruthy()
    expect(screen.queryByTestId('browser-document-page')).toBeNull()
    expect(receivedDaemonPageProps?.daemonBaseUrl).toBe('http://127.0.0.1:3099')
    expect(receivedDaemonPageProps?.workspaceId).toBe('w1')
    expect(receivedDaemonPageProps?.path).toBe('main')
    expect(receivedDaemonPageProps?.token).toBe('tok')
  })

  it('renders a role=alert error UI with a escape to the browser hatch on error', async () => {
    mockDaemonConnectionResult = { status: 'error', detail: 'malformed fragment' }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()
    const button = screen.getByRole('button', { name: /work in this browser instead/i })
    expect(button).toBeTruthy()
    fireEvent.click(button)
    expect(await screen.findByTestId('browser-index-page')).toBeTruthy()
  })

  it('falls through to existing provider-state resolution unchanged when there is no fragment', async () => {
    mockDaemonConnectionResult = { status: 'none' }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('browser-index-page')).toBeTruthy()
    expect(screen.queryByTestId('daemon-document-page')).toBeNull()
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

  it('persists baseUrl/workspaceId/path to user settings on a successful #wb= pairing', async () => {
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: 'w1',
        path: 'main',
        authMode: 'bootstrap',
        bootstrapToken: 'tok',
      },
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-document-page')

    const saved = createUserSettingsStore().load()
    expect(saved.storage.daemonBaseUrl).toBe('http://127.0.0.1:3099')
    expect(saved.storage.lastConnectedWorkspaceId).toBe('w1')
    expect(saved.storage.lastConnectedPath).toBe('main')
  })

  it('never persists the bootstrapToken alongside the connection target', async () => {
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: 'w1',
        path: 'main',
        authMode: 'bootstrap',
        bootstrapToken: 'super-secret-token',
      },
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-document-page')

    expect(localStorage.getItem(STORAGE_KEY) ?? '').not.toContain('super-secret-token')
  })

  it('does not persist a target when there is no #wb= pairing (plain browser session)', () => {
    mockDaemonConnectionResult = { status: 'none' }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    expect(createUserSettingsStore().load().storage.daemonBaseUrl).toBeUndefined()
  })
})

describe('App daemon provider state', () => {
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
        <App providerState={DAEMON_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('daemon-index-page')).toBeTruthy()
    expect(screen.queryByTestId('daemon-document-page')).toBeNull()
    expect(screen.queryByTestId('browser-document-page')).toBeNull()
    expect(screen.queryByText('Whiteboard')).toBeNull()
    expect(receivedDaemonIndexPageProps?.daemonBaseUrl).toBe(DAEMON_STATE.daemonBaseUrl)
    expect(receivedDaemonIndexPageProps?.onOpenDocument).toBeInstanceOf(Function)
  })

  it('mounts DaemonDocumentPage with the opened canvas identity after a gallery selection', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={DAEMON_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-index-page')
    const onOpenDocument = receivedDaemonIndexPageProps?.onOpenDocument as (
      workspaceId: string,
      path: string,
    ) => void
    act(() => {
      onOpenDocument('w1', 'main')
    })
    expect(await screen.findByTestId('daemon-document-page')).toBeTruthy()
    expect(screen.queryByTestId('daemon-index-page')).toBeNull()
    expect(receivedDaemonPageProps?.workspaceId).toBe('w1')
    expect(receivedDaemonPageProps?.path).toBe('main')
    expect(receivedDaemonPageProps?.capabilities).toEqual(DAEMON_STATE.capabilities)
    // browserStore is deliberately NOT passed by App: the page defaults to the
    // shared index itself so the concrete class stays out of the entry chunk
    // (entry-graph-loro-free.test.ts).
    expect(receivedDaemonPageProps?.onNavigateBack).toBeInstanceOf(Function)
  })

  it('passes the daemon-injected token when present', async () => {
    ;(window as { __WHITEBOARD_DAEMON_TOKEN__?: unknown }).__WHITEBOARD_DAEMON_TOKEN__ = 'tok-x'
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={DAEMON_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('daemon-index-page')).toBeTruthy()
    expect(receivedDaemonIndexPageProps?.token).toBe('tok-x')
  })

  it('mounts gracefully with token undefined when the daemon has not injected one', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={DAEMON_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('daemon-index-page')).toBeTruthy()
    expect(receivedDaemonIndexPageProps?.token).toBeUndefined()
  })

  it('returns to the index when DaemonDocumentPage invokes onNavigateBack', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={DAEMON_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-index-page')
    act(() => {
      const onOpenDocument = receivedDaemonIndexPageProps?.onOpenDocument as (
        workspaceId: string,
        path: string,
      ) => void
      onOpenDocument('w1', 'main')
    })
    await screen.findByTestId('daemon-document-page')
    const onNavigateBack = receivedDaemonPageProps?.onNavigateBack as () => void
    act(() => {
      onNavigateBack()
    })
    expect(await screen.findByTestId('daemon-index-page')).toBeTruthy()
    expect(screen.queryByTestId('daemon-document-page')).toBeNull()
  })

  it('preserves the opened canvas workspaceId as initialWorkspaceId when navigating back to the index', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={DAEMON_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-index-page')
    act(() => {
      const onOpenDocument = receivedDaemonIndexPageProps?.onOpenDocument as (
        workspaceId: string,
        path: string,
      ) => void
      onOpenDocument('workspace-b', 'main')
    })
    await screen.findByTestId('daemon-document-page')
    const onNavigateBack = receivedDaemonPageProps?.onNavigateBack as () => void
    act(() => {
      onNavigateBack()
    })
    await screen.findByTestId('daemon-index-page')
    expect(receivedDaemonIndexPageProps?.initialWorkspaceId).toBe('workspace-b')
  })

  it('remounts DaemonDocumentPage cleanly when opening a different canvas after returning to the index', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={DAEMON_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-index-page')
    act(() => {
      const onOpenDocument = receivedDaemonIndexPageProps?.onOpenDocument as (
        workspaceId: string,
        path: string,
      ) => void
      onOpenDocument('w1', 'canvas-a')
    })
    await screen.findByTestId('daemon-document-page')
    expect(receivedDaemonPageProps?.path).toBe('canvas-a')

    const onNavigateBack = receivedDaemonPageProps?.onNavigateBack as () => void
    act(() => {
      onNavigateBack()
    })
    await screen.findByTestId('daemon-index-page')

    act(() => {
      const onOpenDocument = receivedDaemonIndexPageProps?.onOpenDocument as (
        workspaceId: string,
        path: string,
      ) => void
      onOpenDocument('w1', 'canvas-b')
    })
    await screen.findByTestId('daemon-document-page')
    expect(receivedDaemonPageProps?.path).toBe('canvas-b')
  })

  it('names the workspace it resolved, replacing the address that named none', async () => {
    // `/` says nothing about which workspace is on screen. The index picks
    // one anyway — first-listed, or whatever the chain decides — and until it
    // said so, the address bar and the page disagreed: a bookmark of `/`
    // meant "whichever one this resolves to next time", and a reload could
    // land somewhere else.
    const router = createMemoryRouter(
      [{ path: '*', element: <App providerState={DAEMON_STATE} /> }],
      { initialEntries: ['/'] },
    )
    render(<RouterProvider router={router} />)
    await screen.findByTestId('daemon-index-page')

    act(() => {
      const onWorkspaceResolved = receivedDaemonIndexPageProps?.onWorkspaceResolved as (
        workspace: string,
      ) => void
      onWorkspaceResolved('design-team')
    })

    await waitFor(() => expect(router.state.location.pathname).toBe('/w/design-team'))
    // REPLACED, not pushed: naming what was already on screen is not a step a
    // person took, and a back button that returns to `/` would resolve again
    // and push again — a trap of the app's own making.
    expect(router.state.historyAction).toBe('REPLACE')
  })

  it('switching workspace is a history step, so back returns to the previous one', async () => {
    // The other half. Once the address names a workspace, changing it IS a
    // navigation the person made, and back has to undo it.
    const router = createMemoryRouter(
      [{ path: '*', element: <App providerState={DAEMON_STATE} /> }],
      { initialEntries: ['/w/design-team'] },
    )
    render(<RouterProvider router={router} />)
    await screen.findByTestId('daemon-index-page')

    act(() => {
      const onWorkspaceResolved = receivedDaemonIndexPageProps?.onWorkspaceResolved as (
        workspace: string,
      ) => void
      onWorkspaceResolved('sandbox')
    })
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/sandbox'))

    await act(async () => {
      await router.navigate(-1)
    })
    expect(router.state.location.pathname).toBe('/w/design-team')
  })

  it('names the browser workspace in the address, replacing the "/" that named none', async () => {
    // The daemon half of this rule has been in place since the index page
    // learned to report what it resolved. The browser stayed at `/`, which
    // was harmless while it kept exactly one workspace and is not any more:
    // a switcher changes the outermost address layer, and `/` has no layer
    // to change. It also makes the boot chain's own read real — `boot.ts`
    // resolves from `parseWorkspaceRoute(location.pathname)?.workspace`, and
    // at `/` that is always undefined, so a reload fell back to first-listed
    // regardless of where the person was.
    const router = createMemoryRouter(
      [{ path: '*', element: <App providerState={BROWSER_STATE} /> }],
      {
        initialEntries: ['/'],
      },
    )
    render(<RouterProvider router={router} />)
    await screen.findByTestId('browser-index-page')

    await waitFor(() => expect(router.state.location.pathname).toBe('/w/default'))
    // REPLACE for the same reason the daemon does it: the app is finishing a
    // sentence the person started, not taking a step on their behalf.
    expect(router.state.historyAction).toBe('REPLACE')
  })

  it('gives the browser shell a workspace switcher naming what the address says', async () => {
    // The wiring, asserted at the shell rather than at the component: the
    // switcher's own tests prove it renders, and this proves the browser
    // branch actually hands it a source — a control nothing mounts passes
    // every test it has.
    render(
      <MemoryRouter initialEntries={['/w/default']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    const trigger = await screen.findByTestId('workspace-switcher-trigger')
    expect(trigger.textContent).toContain('default')
  })

  it('rewrites an address naming a workspace this browser does not keep', async () => {
    // Left behind by "Work in this browser instead", which switches keeper
    // under a `/w/<daemon-workspace>/d/...` address. The page already falls
    // back to the index for it; the ADDRESS kept naming the daemon's
    // workspace, so the shell would announce a workspace that is not the one
    // being served, and a reload would resolve against a handle that matches
    // nothing here.
    const router = createMemoryRouter(
      [{ path: '*', element: <App providerState={BROWSER_STATE} /> }],
      {
        initialEntries: ['/w/some-daemon-workspace/d/main'],
      },
    )
    render(<RouterProvider router={router} />)
    await screen.findByTestId('browser-index-page')

    await waitFor(() => expect(router.state.location.pathname).toBe('/w/default'))
  })

  it('opens a browser document addressed by the canonical id, not only the segment', async () => {
    // The DURABLE form. ADR-0019 keeps the canonical id resolvable in the
    // same position precisely so a link survives a rename — and the browser
    // route comparison read one layer, so the moment a segment existed the id
    // form matched nothing and fell through to the index. The guarantee the
    // id layer exists to give was absent for this keeper.
    const canonicalId = getBrowserWorkspaceId()
    render(
      <MemoryRouter initialEntries={[`/w/${canonicalId}/d/c1`]}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )

    expect(await screen.findByTestId('browser-document-page')).toBeTruthy()
    expect(screen.queryByTestId('browser-index-page')).toBeNull()
  })

  it('escapes to the browser with BROWSER_CAPABILITIES', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={DAEMON_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-index-page')
    act(() => {
      const onOpenDocument = receivedDaemonIndexPageProps?.onOpenDocument as (
        workspaceId: string,
        path: string,
      ) => void
      onOpenDocument('w1', 'main')
    })
    await screen.findByTestId('daemon-document-page')
    // The escape is the shell's now: a rejected session publishes sync-off,
    // and the chip's popover carries the way out. Driving it from here is
    // what proves App still wires the branch switch behind it.
    act(() => {
      setShellConnection({
        state: { keeper: 'daemon', session: 'sync-off' },
        daemonBaseUrl: 'http://127.0.0.1:3099',
      })
    })
    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    fireEvent.click(await screen.findByRole('button', { name: /work in this browser instead/i }))
    expect(await screen.findByTestId('browser-index-page')).toBeTruthy()
    expect(screen.queryByTestId('daemon-document-page')).toBeNull()
    // Capabilities flow to the editor: open a canvas from the escaped list.
    act(() => receivedIndexPageOnOpenCanvas?.('c1'))
    await screen.findByTestId('browser-document-page')
    expect(receivedCapabilities).toEqual(BROWSER_CAPABILITIES)
    expect(screen.queryByText(/Configured for local daemon/)).toBeNull()
  })

  it('catches an error surfacing through the daemon lazy path (boundary outside Suspense)', async () => {
    throwInDaemonDocumentPage = true
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={DAEMON_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-index-page')
    const reportSpy = vi.spyOn(errorBoundaryLog, 'report').mockImplementation(() => {})
    try {
      act(() => {
        const onOpenDocument = receivedDaemonIndexPageProps?.onOpenDocument as (
          workspaceId: string,
          path: string,
        ) => void
        onOpenDocument('w1', 'main')
      })
      expect(await screen.findByText('Something went wrong')).toBeTruthy()
      expect(reportSpy).toHaveBeenCalled()
    } finally {
      throwInDaemonDocumentPage = false
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

  it('lands on the index when the #wb= payload has no path', async () => {
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: undefined,
        path: undefined,
        authMode: 'bootstrap',
        bootstrapToken: 'tok',
      },
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByTestId('daemon-index-page')).toBeTruthy()
    expect(screen.queryByTestId('daemon-document-page')).toBeNull()
  })

  it('forwards the payload workspaceId as initialWorkspaceId when the #wb= payload has a workspace but no path', async () => {
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: 'workspace-b',
        path: undefined,
        authMode: 'bootstrap',
        bootstrapToken: 'tok',
      },
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_STATE} />
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

  it('cold-loads a /w/:workspaceId/d/:path deep link straight into DaemonDocumentPage', async () => {
    renderAppWithRouter(DAEMON_STATE, '/w/w1/d/main')
    expect(await screen.findByTestId('daemon-document-page')).toBeTruthy()
    expect(receivedDaemonPageProps?.workspaceId).toBe('w1')
    expect(receivedDaemonPageProps?.path).toBe('main')
  })

  it('cold-loads a NESTED document path deep link, path intact', async () => {
    // The tail is the document's path since the data layer converged on
    // paths; the page must receive it verbatim, separators and all.
    renderAppWithRouter(DAEMON_STATE, '/w/w1/d/notes/2026/plan')
    expect(await screen.findByTestId('daemon-document-page')).toBeTruthy()
    expect(receivedDaemonPageProps?.workspaceId).toBe('w1')
    expect(receivedDaemonPageProps?.path).toBe('notes/2026/plan')
  })

  it('cold-loads a /w/:workspaceId deep link into the gallery pre-scoped to that workspace', async () => {
    renderAppWithRouter(DAEMON_STATE, '/w/workspace-b')
    expect(await screen.findByTestId('daemon-index-page')).toBeTruthy()
    expect(receivedDaemonIndexPageProps?.initialWorkspaceId).toBe('workspace-b')
  })

  it('updates the URL when in-app navigation opens a canvas from the gallery', async () => {
    const router = renderAppWithRouter(DAEMON_STATE, '/')
    await screen.findByTestId('daemon-index-page')
    act(() => {
      const onOpenDocument = receivedDaemonIndexPageProps?.onOpenDocument as (
        workspaceId: string,
        path: string,
      ) => void
      onOpenDocument('w1', 'main')
    })
    await screen.findByTestId('daemon-document-page')
    expect(router.state.location.pathname).toBe('/w/w1/d/main')
  })

  it('updates the URL back to the gallery when onNavigateBack fires', async () => {
    const router = renderAppWithRouter(DAEMON_STATE, '/w/w1/d/main')
    await screen.findByTestId('daemon-document-page')
    const onNavigateBack = receivedDaemonPageProps?.onNavigateBack as () => void
    act(() => {
      onNavigateBack()
    })
    await screen.findByTestId('daemon-index-page')
    expect(router.state.location.pathname).toBe('/w/w1')
  })

  it('responds to browser back/forward by updating the rendered view', async () => {
    const router = renderAppWithRouter(DAEMON_STATE, '/')
    await screen.findByTestId('daemon-index-page')
    act(() => {
      const onOpenDocument = receivedDaemonIndexPageProps?.onOpenDocument as (
        workspaceId: string,
        path: string,
      ) => void
      onOpenDocument('w1', 'main')
    })
    await screen.findByTestId('daemon-document-page')

    act(() => {
      router.navigate(-1)
    })
    expect(await screen.findByTestId('daemon-index-page')).toBeTruthy()
    expect(screen.queryByTestId('daemon-document-page')).toBeNull()

    act(() => {
      router.navigate(1)
    })
    expect(await screen.findByTestId('daemon-document-page')).toBeTruthy()
  })

  it('replaces a consumed #wb= pairing with the canonical URL instead of leaving the raw fragment behind', async () => {
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: 'w1',
        path: 'main',
        authMode: 'bootstrap',
        bootstrapToken: 'tok',
      },
    }
    const router = renderAppWithRouter(BROWSER_STATE, '/')
    await screen.findByTestId('daemon-document-page')
    expect(router.state.location.pathname).toBe('/w/w1/d/main')
    // The replace must not have added a new history entry: going back from
    // here should leave the SPA (nothing left to land on inside this test's
    // single-entry history), not bounce to a stale pre-pairing '/' entry.
    expect(router.state.location.key).not.toBe('default')
  })

  it('shows the not-found page for an unrecognized path (no blank page, no silent redirect)', async () => {
    renderAppWithRouter(DAEMON_STATE, '/something/unrelated/entirely')
    expect(await screen.findByRole('button', { name: /back to documents/i })).toBeTruthy()
    expect(screen.queryByTestId('daemon-index-page')).toBeNull()
  })
})

describe('App shell (single instance above the routed pages)', () => {
  it('browser branch renders exactly one shell whose gear navigates with the entry point', async () => {
    const router = createMemoryRouter(
      [{ path: '*', element: <App providerState={BROWSER_STATE} /> }],
      {
        initialEntries: ['/'],
      },
    )
    render(<RouterProvider router={router} />)
    await screen.findByTestId('browser-index-page')
    expect(screen.getAllByTestId('shell-settings')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy()

    fireEvent.click(screen.getByTestId('shell-settings'))
    expect(router.state.location.pathname).toBe('/settings')
    // `/w/default`, not `/`: the address names its workspace by the time the
    // gear is clicked, and the entry point records where the person actually
    // was. Coming back to `/` would resolve a workspace again rather than
    // returning to the one they left.
    expect((router.state.location.state as { from?: string }).from).toBe('/w/default')
    // The settings branch keeps exactly one shell too — the page brings none
    // of its own.
    expect(screen.getAllByTestId('shell-settings')).toHaveLength(1)
  })

  it('the paired-fragment branch renders the shell too — Settings/Home must survive every entry path', async () => {
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: 'w1',
        path: 'main',
        authMode: 'bootstrap',
        bootstrapToken: 'tok',
      },
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-document-page')
    expect(screen.getAllByTestId('shell-settings')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy()
  })

  it('daemon branch renders the shell and a reported auth error lights its attention dot', async () => {
    mockDaemonConnectionResult = { status: 'none' }
    Object.defineProperty(navigator, 'storage', {
      value: { persisted: () => Promise.resolve(true) },
      configurable: true,
    })
    try {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App providerState={DAEMON_STATE} />
        </MemoryRouter>,
      )
      await screen.findByTestId('daemon-index-page')
      expect(screen.getAllByTestId('shell-settings')).toHaveLength(1)
      await waitFor(() => expect(screen.queryByTestId('settings-nudge')).toBeNull())

      act(() => {
        setShellConnection({
          state: { keeper: 'daemon', session: 'sync-off' },
          daemonBaseUrl: 'http://127.0.0.1:3099',
        })
      })
      expect(screen.getByTestId('settings-nudge')).toBeTruthy()
      // The mark is the shell's now, so the state a page reports reaches the
      // user here rather than inside the page's own top bar. Read from the
      // accessible name: the mark carries the state as colour and motion and
      // has no room for the word.
      expect(screen.getByTestId('shell-mark-trigger').getAttribute('aria-label')).toMatch(
        /sync off/i,
      )
    } finally {
      Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true })
    }
  })
})

describe('App /settings routing', () => {
  beforeEach(() => {
    receivedSettingsPageProps = undefined
    mockDaemonConnectionResult = { status: 'none' }
  })
  afterEach(() => {
    mockDaemonConnectionResult = { status: 'none' }
  })

  it('mounts SettingsPage for /settings and its sub-routes instead of the usual view', async () => {
    for (const path of [
      '/settings',
      '/settings/general',
      '/settings/data',
      '/settings/connections',
    ]) {
      renderAppWithRouter(BROWSER_STATE, path)
      expect(await screen.findByTestId('settings-page')).toBeTruthy()
      cleanup()
    }
  })

  it('does not rewrite /settings to the daemon route (the URL-sync guard)', async () => {
    const router = renderAppWithRouter(DAEMON_STATE, '/settings')
    await screen.findByTestId('settings-page')
    expect(router.state.location.pathname).toBe('/settings')
  })

  it('passes no daemon prop in browser mode with no active connection', async () => {
    renderAppWithRouter(BROWSER_STATE, '/settings')
    await screen.findByTestId('settings-page')
    expect(receivedSettingsPageProps?.daemon).toBeUndefined()
  })

  it('passes the daemon baseUrl/token when the provider state is "daemon"', async () => {
    renderAppWithRouter(DAEMON_STATE, '/settings')
    await screen.findByTestId('settings-page')
    expect(receivedSettingsPageProps?.daemon).toEqual({
      baseUrl: DAEMON_STATE.kind === 'daemon' ? DAEMON_STATE.daemonBaseUrl : '',
      token: null,
    })
  })

  it('passes the paired fragment daemon baseUrl/token over the provider state', async () => {
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: undefined,
        path: undefined,
        authMode: 'bootstrap',
        bootstrapToken: 'tok',
      },
    }
    renderAppWithRouter(BROWSER_STATE, '/settings')
    await screen.findByTestId('settings-page')
    expect(receivedSettingsPageProps?.daemon).toEqual({
      baseUrl: 'http://127.0.0.1:3099',
      token: 'tok',
    })
  })

  it('passes token: null for a paired fragment connection with authMode "none" (no bootstrap token)', async () => {
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: undefined,
        path: undefined,
        authMode: 'none',
      },
    }
    renderAppWithRouter(BROWSER_STATE, '/settings')
    await screen.findByTestId('settings-page')
    expect(receivedSettingsPageProps?.daemon).toEqual({
      baseUrl: 'http://127.0.0.1:3099',
      token: null,
    })
  })

  it('passes the daemon from a session grant established via the silent-renewal seam', async () => {
    // Same mechanism as the "silent renewal" suite above: a stored
    // daemonBaseUrl plus a 'paired' renewPairingToken result lands in
    // grantConnection, which /settings must resolve exactly like a #wb-grant
    // fragment consumed directly on this route would.
    localStorage.clear()
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        storage: { daemonBaseUrl: 'http://127.0.0.1:3099' },
        migration: {},
        capabilities: {},
      }),
    )
    mockRenewResult = { status: 'paired', daemonBaseUrl: 'http://127.0.0.1:3099', token: 'tok-r' }
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/settings']}>
          <App providerState={BROWSER_STATE} />
        </MemoryRouter>,
      )
    })
    await screen.findByTestId('settings-page')
    expect(receivedSettingsPageProps?.daemon).toEqual({
      baseUrl: 'http://127.0.0.1:3099',
      token: 'tok-r',
    })
    renewPairingTokenMock.mockClear()
    mockRenewResult = { status: 'none' }
    localStorage.clear()
  })
})

describe('App error boundary', () => {
  beforeEach(() => {
    throwInBrowserDocumentPage = false
  })
  afterEach(() => {
    throwInBrowserDocumentPage = false
  })

  it('catches a render error from the active page and shows the fallback instead of crashing the app', async () => {
    throwInBrowserDocumentPage = true
    const reportSpy = vi.spyOn(errorBoundaryLog, 'report').mockImplementation(() => {})
    render(
      <MemoryRouter initialEntries={['/w/default/d/c1']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('Something went wrong')).toBeTruthy()
    expect(reportSpy).toHaveBeenCalled()
    reportSpy.mockRestore()
  })

  it('catches an error surfacing through the paired branch lazy path (boundary sits outside Suspense)', async () => {
    throwInDaemonDocumentPage = true
    mockDaemonConnectionResult = {
      status: 'paired',
      payload: {
        baseUrl: 'http://127.0.0.1:3099',
        workspaceId: 'w1',
        path: 'main',
        authMode: 'bootstrap',
        bootstrapToken: 'tok',
      },
    }
    const reportSpy = vi.spyOn(errorBoundaryLog, 'report').mockImplementation(() => {})
    try {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App providerState={BROWSER_STATE} />
        </MemoryRouter>,
      )
      // The lazy module resolves after a microtask; the throw then propagates
      // through Suspense's error path to the boundary outside it.
      expect(await screen.findByText('Something went wrong')).toBeTruthy()
      expect(reportSpy).toHaveBeenCalled()
    } finally {
      throwInDaemonDocumentPage = false
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
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    // The page chunk is lazy — wait for it to resolve.
    expect(await screen.findByRole('button', { name: /back to documents/i })).toBeTruthy()
    expect(document.querySelector('[data-mark="not-found"]')).toBeTruthy()
  })

  it('keeps known routes on their normal pages', () => {
    render(
      <MemoryRouter initialEntries={['/w/default/d/c9']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    expect(document.querySelector('[data-mark="not-found"]')).toBeNull()
  })
})
