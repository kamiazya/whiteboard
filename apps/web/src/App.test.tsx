import { resetTokenStoreForTests } from '@kamiazya/whiteboard-mcp/api-client'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.js'
import { errorBoundaryLog } from './components/ErrorBoundary.js'
import type { DaemonConnectionResult } from './hooks/useDaemonConnection.js'
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

// useDaemonConnection is a module-level singleton (see its own test file for
// why) — mocked here so App routing tests control its result directly
// instead of round-tripping through window.location.hash.
let mockDaemonConnectionResult: DaemonConnectionResult = { status: 'none' }
vi.mock('./hooks/useDaemonConnection.js', () => ({
  useDaemonConnection: () => mockDaemonConnectionResult,
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

describe('App backend configuration chip', () => {
  it('shows "Browser only" when configured for browser-local storage', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    expect(screen.getByText('Browser only')).toBeTruthy()
  })

  it('shows the daemon URL when configured for a local daemon', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={LOCAL_DAEMON_STATE} />
      </MemoryRouter>,
    )
    expect(screen.getByText('Configured for local daemon at http://127.0.0.1:3000')).toBeTruthy()
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

  it('lets the browser-local escape override invalid-config after a failed pairing', () => {
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
      expect(screen.getByTestId('browser-local-canvas-page')).toBeTruthy()
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

  it('passes the browser-local capabilities down to BrowserLocalCanvasPage', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    expect(receivedCapabilities).toEqual(BROWSER_LOCAL_STATE.capabilities)
  })

  it('derives initialCanvasId from a /local/:canvasId cold-load URL', () => {
    receivedInitialCanvasId = undefined
    render(
      <MemoryRouter initialEntries={['/local/c2']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    expect(receivedInitialCanvasId).toBe('c2')
  })

  it('leaves initialCanvasId undefined for a plain "/" cold load', () => {
    receivedInitialCanvasId = undefined
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    expect(receivedInitialCanvasId).toBeUndefined()
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

  it('renders a role=alert error UI with a browser-local escape hatch on error', () => {
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
    expect(screen.getByTestId('browser-local-canvas-page')).toBeTruthy()
  })

  it('falls through to existing provider-state resolution unchanged when there is no fragment', () => {
    mockDaemonConnectionResult = { status: 'none' }
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('browser-local-canvas-page')).toBeTruthy()
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

  it('escapes to browser-local with BROWSER_LOCAL_CAPABILITIES and neutral chip/banner copy', async () => {
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
    expect(screen.getByTestId('browser-local-canvas-page')).toBeTruthy()
    expect(screen.queryByTestId('daemon-canvas-page')).toBeNull()
    expect(receivedCapabilities).toEqual(BROWSER_LOCAL_CAPABILITIES)
    expect(screen.getByText('Browser only')).toBeTruthy()
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

  it('falls back to the unscoped index for an unrecognized path (no blank page)', async () => {
    renderAppWithRouter(LOCAL_DAEMON_STATE, '/something/unrelated/entirely')
    expect(await screen.findByTestId('daemon-index-page')).toBeTruthy()
  })
})

describe('App error boundary', () => {
  beforeEach(() => {
    throwInBrowserLocalCanvasPage = false
  })
  afterEach(() => {
    throwInBrowserLocalCanvasPage = false
  })

  it('catches a render error from the active page and shows the fallback instead of crashing the app', () => {
    throwInBrowserLocalCanvasPage = true
    const reportSpy = vi.spyOn(errorBoundaryLog, 'report').mockImplementation(() => {})
    render(
      <MemoryRouter initialEntries={['/']}>
        <App providerState={BROWSER_LOCAL_STATE} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()
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
