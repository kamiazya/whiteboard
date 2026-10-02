import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.js'
import { errorBoundaryLog } from './components/ErrorBoundary.js'
import { LazyPageFallback } from './components/LazyPageFallback.js'
import { BRIDGE_DAEMON_BASE_URL } from './lib/bridge-address.js'
import {
  getBrowserWorkspaceId,
  resetBrowserWorkspaceIdForTests,
  setBrowserWorkspaceIdForTests,
} from './lib/browser-workspace-id.js'
import type { ExtensionConnection } from './lib/extension-connection.js'
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
import { type ProviderState, resolveHostedProviderStateFromRaw } from './lib/provider.js'
import { STORAGE_KEY } from './lib/user-settings-store.js'
import { jsonResponse } from './test-utils/json-response.js'
import { expectLoggedFailure } from './test-utils/logged-failures.js'

afterEach(() => {
  cleanup()
  // File-wide: several tests publish a shell connection to drive the chip,
  // and a leftover sync-off lights the settings nudge for whichever test
  // runs next.
  resetShellStatusForTests()
})

// BrowserDocumentPage pulls in loro-crdt, which needs a real browser (WASM),
// so it stays mocked. It used to capture a `capabilities` prop as well —
// that prop is gone, along with the map behind it.
// Captures the initialPath prop so a test can assert App derives it from
// the /w/:workspace/d/:path URL (parseBrowserRoute) rather than merely
// mounting the page.
let receivedInitialPath: string | undefined
// Toggled by the error-boundary test to force the mocked page to throw
// during render, so App's ErrorBoundary wiring has something real to catch.
let throwInBrowserDocumentPage = false
// jsdom has no IndexedDB, so the counts panel's startup fold cannot run: it
// throws, the production path catches it and continues, and that guarded
// continue is what this file already ran under. Mocked to the same outcome
// because the warn on the way is ONCE PER PROCESS — the module memoises the
// attempt — so it cannot be claimed by a test either. Measured:
// `stress-changed-tests` runs a touched file five times and the claim passed
// five times and failed on the repeat, which is exactly the shape that job
// exists to find.
vi.mock('./lib/fold-workspace.js', () => ({
  foldWorkspaceDocuments: async () => ({ folded: 0, skipped: 0 }),
}))

vi.mock('./pages/BrowserDocumentPage.js', () => ({
  BrowserDocumentPage: ({ initialPath }: { initialPath?: string }) => {
    receivedInitialPath = initialPath
    if (throwInBrowserDocumentPage) {
      throw new Error('boom')
    }
    return <div data-testid="browser-document-page" />
  },
}))

// Captures the open callback so a test can drive list -> editor navigation
// without rendering the real list (which would pull in the store's IDB path).
let receivedIndexPageOnOpenDocument: ((path: string) => void) | undefined
vi.mock('./pages/BrowserIndexPage.js', () => ({
  BrowserIndexPage: ({ onOpenDocument }: { onOpenDocument: (path: string) => void }) => {
    receivedIndexPageOnOpenDocument = onOpenDocument
    return <div data-testid="browser-index-page" />
  },
}))

// The reconnection seam: a remembered daemon is asked through the extension
// (ADR-0050), and jsdom has none, so the answer is the test's to give.
let mockConnectResult: ExtensionConnection = { status: 'none' }
const connectThroughExtensionMock = vi.fn(async () => mockConnectResult)
vi.mock('./lib/extension-connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/extension-connection.js')>()),
  connectThroughExtension: () => connectThroughExtensionMock(),
}))

const CONNECTED: ExtensionConnection = {
  status: 'connected',
  daemonBaseUrl: BRIDGE_DAEMON_BASE_URL,
  token: '',
}

/** A settings record that remembers `daemonBaseUrl`, as a later cold load finds it. */
function rememberDaemon(daemonBaseUrl: string, extra: Record<string, unknown> = {}) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 5,
      storage: { daemonBaseUrl, ...extra },
      migration: {},
      // The USER SETTINGS' capabilities (`webMcpEnabled`). Required by a
      // `.strict()` schema whose loader falls back to defaults on any parse
      // failure — so dropping it here does not fail loudly, it silently
      // discards the stored daemon URL and every test renders browser mode.
      capabilities: {},
    }),
  )
}

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

let receivedReplicaPageProps: Record<string, unknown> | undefined
vi.mock('./pages/ReplicaReadPage.js', () => ({
  ReplicaReadPage: (props: Record<string, unknown>) => {
    receivedReplicaPageProps = props
    return (
      <div data-testid="replica-read-page-stub" data-workspace-id={String(props.workspaceId)}>
        <button
          type="button"
          onClick={() => void (props.onReconnect as () => void | Promise<void>)()}
        >
          Reconnect
        </button>
      </div>
    )
  },
}))

let receivedDaemonIndexPageProps: Record<string, unknown> | undefined
vi.mock('./pages/DaemonIndexPage.js', () => ({
  DaemonIndexPage: (props: Record<string, unknown>) => {
    receivedDaemonIndexPageProps = props
    return <div data-testid="daemon-index-page" />
  },
}))

// S4b's replica-key-holder wiring: watched through this spy rather than
// through a real IndexedDB round-trip — App's own contract is WHICH daemon
// (and whose credentials) it hands the holder, not what the holder then
// does with them (replica-store.browser.test.tsx covers that separately).
const connectReplicaKeeperMock = vi.fn()
vi.mock('./lib/replica-store.js', () => ({
  connectReplicaKeeper: (...args: unknown[]) => connectReplicaKeeperMock(...args),
}))

const BROWSER_STATE: ProviderState = {
  kind: 'browser',
}

const DAEMON_STATE: ProviderState = {
  kind: 'daemon',
  daemonBaseUrl: 'http://127.0.0.1:3000',
}

const INVALID_CONFIG_STATE: ProviderState = {
  kind: 'invalid-config',
  message: 'Runtime configuration is invalid.',
}

describe('reconnecting a remembered daemon through the extension', () => {
  beforeEach(() => {
    resetShellStatusForTests()
    localStorage.clear()
    connectThroughExtensionMock.mockClear()
    connectReplicaKeeperMock.mockClear()
    mockConnectResult = { status: 'none' }
  })

  it('reconnects to the stored daemon and renders daemon mode', async () => {
    rememberDaemon(BRIDGE_DAEMON_BASE_URL)
    mockConnectResult = CONNECTED
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App providerState={BROWSER_STATE} />
        </MemoryRouter>,
      )
    })

    await screen.findByTestId('daemon-index-page')
    expect(connectThroughExtensionMock).toHaveBeenCalledOnce()
    // The page holds no daemon token: the host supplies the daemon's own.
    expect(receivedDaemonIndexPageProps).toMatchObject({
      daemonBaseUrl: BRIDGE_DAEMON_BASE_URL,
      token: '',
    })
    // S4b: the resolved daemon reaches the replica-key holder too, not only
    // the page.
    await vi.waitFor(() => {
      expect(connectReplicaKeeperMock).toHaveBeenLastCalledWith({
        baseUrl: BRIDGE_DAEMON_BASE_URL,
        token: '',
      })
    })
  })

  it('serves the replica read-only when the daemon is unreachable and a replica exists', async () => {
    // ADR-0023's offline read: the address names a daemon workspace this
    // browser holds a replica of, the daemon cannot be reached, so the
    // replica page serves it — addressed by SEGMENT, resolved to the
    // canonical id the registry keys by.
    rememberDaemon(BRIDGE_DAEMON_BASE_URL, {
      replicas: {
        '01ARZ3NDEKTSV4RRFFQ69G5FAV': {
          daemonBaseUrl: BRIDGE_DAEMON_BASE_URL,
          syncedAt: '2026-09-01T12:00:00.000Z',
          segment: 'team',
          displayName: 'Design team',
        },
      },
    })
    mockConnectResult = { status: 'none' }
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/w/team']}>
          <App providerState={BROWSER_STATE} />
        </MemoryRouter>,
      )
    })
    const page = await screen.findByTestId('replica-read-page-stub')
    expect(page.getAttribute('data-workspace-id')).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(receivedReplicaPageProps?.daemonBaseUrl).toBe(BRIDGE_DAEMON_BASE_URL)
  })

  it('Reconnect re-runs renewal, and a now-paired answer unmounts the replica page for the daemon page', async () => {
    rememberDaemon(BRIDGE_DAEMON_BASE_URL, {
      replicas: {
        '01ARZ3NDEKTSV4RRFFQ69G5FAV': {
          daemonBaseUrl: BRIDGE_DAEMON_BASE_URL,
          syncedAt: '2026-09-01T12:00:00.000Z',
          segment: 'team',
          displayName: 'Design team',
        },
      },
    })
    mockConnectResult = { status: 'none' }
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/w/team']}>
          <App providerState={BROWSER_STATE} />
        </MemoryRouter>,
      )
    })
    await screen.findByTestId('replica-read-page-stub')
    connectThroughExtensionMock.mockClear()
    mockConnectResult = CONNECTED
    await act(async () => {
      screen.getByRole('button', { name: 'Reconnect' }).click()
    })
    expect(connectThroughExtensionMock).toHaveBeenCalledTimes(1)
    await screen.findByTestId('daemon-index-page')
    expect(screen.queryByTestId('replica-read-page-stub')).toBeNull()
  })

  it('serves the replica read-only for a cold load of a /w/:id/d/:path address keyed by canonical id, no segment', async () => {
    // The read-plane smoke's exact shape: a document route (not an index
    // route) naming the registry's key directly (no `segment` recorded —
    // replica-refresh.ts omits it when a daemon workspace has none). A
    // registry lookup keyed on `segment` alone, or a replica branch gated
    // to index routes, would both miss this and fall through to the
    // browser flow instead of the locked states ADR-0042 S5 ships.
    const workspaceId = '01BRWAAAAAAAAAAAAAAAAAAAA1'
    rememberDaemon(BRIDGE_DAEMON_BASE_URL, {
      replicas: {
        [workspaceId]: {
          daemonBaseUrl: BRIDGE_DAEMON_BASE_URL,
          syncedAt: '2026-09-01T12:00:00.000Z',
        },
      },
    })
    mockConnectResult = { status: 'none' }
    await act(async () => {
      render(
        <MemoryRouter initialEntries={[`/w/${workspaceId}/d/moved-note`]}>
          <App providerState={BROWSER_STATE} />
        </MemoryRouter>,
      )
    })
    const page = await screen.findByTestId('replica-read-page-stub')
    expect(page.getAttribute('data-workspace-id')).toBe(workspaceId)
    expect(screen.queryByTestId('browser-document-page')).toBeNull()
    expect(screen.queryByTestId('browser-index-page')).toBeNull()
  })

  it('an address with no replica behind it still falls to the browser flow when unreachable', async () => {
    rememberDaemon(BRIDGE_DAEMON_BASE_URL)
    mockConnectResult = { status: 'none' }
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/w/team']}>
          <App providerState={BROWSER_STATE} />
        </MemoryRouter>,
      )
    })
    expect(await screen.findByTestId('browser-index-page')).toBeTruthy()
    expect(screen.queryByTestId('replica-read-page-stub')).toBeNull()
  })

  it('falls back to the browser when renewal reports none (revoked / unreachable)', async () => {
    rememberDaemon(BRIDGE_DAEMON_BASE_URL)
    mockConnectResult = { status: 'none' }
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <App providerState={BROWSER_STATE} />
        </MemoryRouter>,
      )
    })

    await screen.findByTestId('browser-index-page')
    expect(screen.queryByTestId('daemon-index-page')).toBeNull()
    // S4b: no resolved daemon means the replica-key holder is told to
    // disconnect too, so a stale held key does not keep answering.
    await vi.waitFor(() => {
      expect(connectReplicaKeeperMock).toHaveBeenLastCalledWith(null)
    })
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
    expect(connectThroughExtensionMock).not.toHaveBeenCalled()
  })

  // ADR-0050: a loopback address the pairing flow once remembered is not a
  // way to reach a daemon any more. The page treats it as nothing remembered,
  // and the person reconnects through the extension.
  it('does not reconnect to a remembered loopback address', async () => {
    rememberDaemon('http://127.0.0.1:3099')
    mockConnectResult = CONNECTED
    const fetchSpy = vi.fn((_url: unknown) =>
      Promise.reject(new TypeError('no network in this test')),
    )
    vi.stubGlobal('fetch', fetchSpy)
    try {
      await act(async () => {
        render(
          <MemoryRouter initialEntries={['/']}>
            <App providerState={BROWSER_STATE} />
          </MemoryRouter>,
        )
      })
      await screen.findByTestId('browser-index-page')
      expect(screen.queryByTestId('daemon-index-page')).toBeNull()
      expect(connectThroughExtensionMock).not.toHaveBeenCalled()
      expect(fetchSpy.mock.calls.map(([url]) => String(url))).not.toContainEqual(
        expect.stringContaining('127.0.0.1'),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not rewrite a daemon deep link to the browser index while the stored connection is still renewing', async () => {
    // App.tsx's own `awaitingDaemonRenewal`. `connectThroughExtension` is held
    // open here (rather than resolved inside the same act flush, as every
    // other case in this suite does) so there is a real window where the
    // renewal is neither settled nor decided, which is exactly the window
    // that field exists to cover.
    const workspaceId = '01BRWAAAAAAAAAAAAAAAAAAAA3'
    rememberDaemon(BRIDGE_DAEMON_BASE_URL)
    let resolveRenewal: (result: ExtensionConnection) => void = () => {}
    connectThroughExtensionMock.mockImplementationOnce(
      () =>
        new Promise<ExtensionConnection>((resolve) => {
          resolveRenewal = resolve
        }),
    )
    const router = createMemoryRouter(
      [{ path: '*', element: <App providerState={BROWSER_STATE} /> }],
      { initialEntries: [`/w/${workspaceId}/d/moved-note`] },
    )
    render(<RouterProvider router={router} />)

    // Undecided, not foreign: the address stays exactly as asked while the
    // renewal is open, and the browser's workspace is not rendered — the two
    // keepers can share a segment, so its page could lead elsewhere first.
    await screen.findByText('Connecting to the daemon…')
    expect(router.state.location.pathname).toBe(`/w/${workspaceId}/d/moved-note`)
    expect(screen.queryByTestId('browser-index-page')).toBeNull()
    expect(screen.queryByTestId('daemon-document-page')).toBeNull()

    await act(async () => {
      resolveRenewal(CONNECTED)
    })

    await screen.findByTestId('daemon-document-page')
    expect(receivedDaemonPageProps).toMatchObject({ workspaceId, path: 'moved-note' })
    // The link survived: once paired, it opens the document the address
    // named all along rather than whatever the (now moot) rewrite chose.
    expect(router.state.location.pathname).toBe(`/w/${workspaceId}/d/moved-note`)
  })

  it('releases the gate on a failed renewal too, and the deep link then falls through to the browser', async () => {
    // The symmetric case to the one above: `awaitingDaemonRenewal` must
    // release on the FAILURE resolution as well as the success one — the
    // field turns false the moment `renewal` stops being null, which
    // 'unreachable' satisfies. Held open
    // the same way, so there is a real pending window to assert the address
    // survives before proving it stops being undecided afterwards.
    const workspaceId = '01BRWAAAAAAAAAAAAAAAAAAAA5'
    rememberDaemon(BRIDGE_DAEMON_BASE_URL)
    let resolveRenewal: (result: ExtensionConnection) => void = () => {}
    connectThroughExtensionMock.mockImplementationOnce(
      () =>
        new Promise<ExtensionConnection>((resolve) => {
          resolveRenewal = resolve
        }),
    )
    const router = createMemoryRouter(
      [{ path: '*', element: <App providerState={BROWSER_STATE} /> }],
      { initialEntries: [`/w/${workspaceId}/d/moved-note`] },
    )
    render(<RouterProvider router={router} />)

    // Still undecided: same pending assertion as the success case above.
    await screen.findByText('Connecting to the daemon…')
    expect(router.state.location.pathname).toBe(`/w/${workspaceId}/d/moved-note`)

    await act(async () => {
      resolveRenewal({ status: 'none' })
    })

    // Gate released, and this workspace is nobody's browser workspace — the
    // browser-keeper rewrite effect (use-workspace-address-sync.ts) now runs
    // and lands on the browser's own workspace, the same way an address
    // naming a workspace this browser never kept always does.
    await waitFor(() => expect(router.state.location.pathname).toBe('/w/default'))
    await screen.findByTestId('browser-index-page')
  })
})

describe('/pair', () => {
  // ADR-0050: a local daemon is reached through the extension, so there is no
  // pairing to consent to and the daemon's consent page is not a route here.
  it('is not a route', async () => {
    render(
      <MemoryRouter initialEntries={['/pair?origin=https%3A%2F%2Fexample.com&challenge=c&state=s']}>
        <App providerState={DAEMON_STATE} />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('button', { name: /back to documents/i })).toBeTruthy()
    expect(document.querySelector('[data-mark="not-found"]')).toBeTruthy()
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
})

describe('App keeper wiring', () => {
  // The capability map this described is gone: both keepers answer the same
  // for everything it held, and what still differs is answered per document
  // by the backend instead. What survives is the wiring itself — App resolves
  // a provider kind and mounts the page that belongs to it.
  it('mounts BrowserDocumentPage for the browser keeper', async () => {
    render(
      <MemoryRouter initialEntries={['/w/default/d/c1']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('browser-document-page')
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
    expect(receivedIndexPageOnOpenDocument).toBeDefined()
    act(() => receivedIndexPageOnOpenDocument?.('notes/c9'))
    expect(await screen.findByTestId('browser-document-page')).toBeTruthy()
    expect(receivedInitialPath).toBe('notes/c9')
  })
})

describe('App daemon provider state', () => {
  beforeEach(() => {
    receivedDaemonPageProps = undefined
    receivedDaemonIndexPageProps = undefined
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
    // browserStore is deliberately NOT passed by App: the page defaults to the
    // shared index itself so the concrete class stays out of the entry chunk
    // (entry-graph-loro-free.test.ts).
    expect(receivedDaemonPageProps?.onNavigateBack).toBeInstanceOf(Function)
  })

  it('hands the page no token: the browser holds none', async () => {
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

  it('preserves the opened canvas workspaceId as the addressed workspace when navigating back to the index', async () => {
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
    expect(receivedDaemonIndexPageProps?.workspace).toBe('workspace-b')
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

  it('switching workspace from the shell moves the address and the daemon page with it', async () => {
    // The switcher is the ONE carrier now — the index page's own select is
    // gone — so this is the whole path: the shell changes the view, the view
    // writes the address, and the page follows the address.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            workspaces: [
              { workspaceId: 'w1', segment: 'design' },
              { workspaceId: 'w2', segment: 'sandbox' },
            ],
          }),
        ),
      ),
    )
    const router = createMemoryRouter(
      [{ path: '*', element: <App providerState={DAEMON_STATE} /> }],
      { initialEntries: ['/w/design'] },
    )
    render(<RouterProvider router={router} />)
    await screen.findByTestId('daemon-index-page')

    fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
    fireEvent.click(await screen.findByRole('menuitem', { name: /sandbox/i }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/w/sandbox'))
    expect(receivedDaemonIndexPageProps?.workspace).toBe('sandbox')
  })

  it('mounts the document once the workspace identity settles after first paint', async () => {
    // `boot.ts` bounds the identity resolve at 3s and renders DEGRADED past
    // it — a stale tab blocking the IndexedDB version upgrade is the
    // realistic way there, and this PR's own v15 migration is exactly such an
    // upgrade. Past that bound the identity settles while React is already
    // mounted, and a module-level accessor that nobody subscribes to updates
    // without re-rendering anything: the deep link stays on the index, and
    // `browserHandle === null` disables every navigation out of it. Not a
    // slow start — a permanently unusable app until a reload.
    const settled = getBrowserWorkspaceId()
    resetBrowserWorkspaceIdForTests()
    try {
      render(
        <MemoryRouter initialEntries={['/w/default/d/c1']}>
          <App providerState={BROWSER_STATE} />
        </MemoryRouter>,
      )
      expect(await screen.findByTestId('browser-index-page')).toBeTruthy()

      act(() => setBrowserWorkspaceIdForTests(settled, 'default'))

      expect(await screen.findByTestId('browser-document-page')).toBeTruthy()
    } finally {
      setBrowserWorkspaceIdForTests(settled, 'default')
    }
  })

  it('rewrites an address naming a workspace the registry cannot resolve', async () => {
    // The other half, and why the switch resolve is STRICT. A lenient one
    // would answer any unknown handle with first-listed, and the effect would
    // then leave the address alone while believing it had switched — an
    // address naming a workspace nobody has.
    const settled = getBrowserWorkspaceId()
    const router = createMemoryRouter(
      [{ path: '*', element: <App providerState={BROWSER_STATE} /> }],
      { initialEntries: ['/w/no-such-workspace'] },
    )
    render(<RouterProvider router={router} />)
    await screen.findByTestId('browser-index-page')

    await waitFor(() => expect(router.state.location.pathname).toBe('/w/default'))
    expect(getBrowserWorkspaceId()).toBe(settled)
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
    // On the MARK, and in its accessible name: the shell does not draw the
    // workspace's name in the row (the "Mark as Switcher" record answers
    // "where does the workspace name appear at all?" with "the shell need
    // not name it"), so the wiring shows up as the name the mark states.
    const trigger = await screen.findByTestId('shell-mark-trigger')
    expect(trigger.getAttribute('aria-label')).toContain('default')
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
    // The editor opens from the escaped list.
    act(() => receivedIndexPageOnOpenDocument?.('c1'))
    await screen.findByTestId('browser-document-page')
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
    await expectLoggedFailure('The above error occurred')
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
    expect(receivedDaemonIndexPageProps?.workspace).toBe('workspace-b')
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
    // The mark stopped being a destination and gained no replacement: a
    // cross-workspace "all documents" view is a state this product does not
    // have. What must survive every entry path is the SHELL — the gear below
    // and the mark's own popover — not a link home that no longer exists.
    expect(screen.getByTestId('shell-mark-trigger')).toBeTruthy()

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

  it('the reconnected branch renders the shell too — Settings/Home must survive every entry path', async () => {
    localStorage.clear()
    rememberDaemon(BRIDGE_DAEMON_BASE_URL)
    mockConnectResult = CONNECTED
    render(
      <MemoryRouter initialEntries={['/w/w1/d/main']}>
        <App providerState={BROWSER_STATE} />
      </MemoryRouter>,
    )
    await screen.findByTestId('daemon-document-page')
    mockConnectResult = { status: 'none' }
    localStorage.clear()
    expect(screen.getAllByTestId('shell-settings')).toHaveLength(1)
    // The mark stopped being a destination and gained no replacement: a
    // cross-workspace "all documents" view is a state this product does not
    // have. What must survive every entry path is the SHELL — the gear below
    // and the mark's own popover — not a link home that no longer exists.
    expect(screen.getByTestId('shell-mark-trigger')).toBeTruthy()
  })

  it('daemon branch renders the shell and a reported auth error lights its attention dot', async () => {
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

  it('opens a mark popover with something in it on /settings, in both keepers', async () => {
    // The shell states this as an invariant: the mark "opens on every page —
    // the workspace is a fact everywhere, so there is always something for
    // the popover to say". /settings broke it. Every child of the popover is
    // conditional, and on this route all of them were false at once: the
    // route passed no `workspaces`, and only DOCUMENT pages publish shell
    // status, so the connection was null too. The control opened onto
    // nothing — measured at innerHTML.length === 0 in a real browser.
    for (const state of [BROWSER_STATE, DAEMON_STATE]) {
      renderAppWithRouter(state, '/settings')
      await screen.findByTestId('settings-page')
      fireEvent.click(await screen.findByTestId('shell-mark-trigger'))
      const popover = await screen.findByTestId('shell-mark-popover')
      // Emptiness is the defect, so emptiness is what this asserts against —
      // not any particular wording, which would pin the copy instead of the
      // invariant.
      //
      // What this does NOT pin, said plainly because the loop looks like it
      // does: WHICH source each keeper gets. Both lists come back empty here,
      // so both states render the identical "Switch to＋New workspace" —
      // measured. Swapping the daemon arm for the browser one leaves this
      // green. The two iterations still earn their place, since an absent or
      // throwing source on either arm fails them; the source CHOICE is keyed
      // off the same `settingsDaemon` as the `daemon` prop beside it, and
      // that pairing is what keeps them from disagreeing.
      expect(popover.textContent?.trim()).not.toBe('')
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
    // settingsDaemon is undefined in browser mode, so the ternary that
    // gates workspaceId on it must answer undefined too — regardless of
    // whatever daemonView.workspace happens to hold.
    expect(receivedSettingsPageProps?.workspaceId).toBeUndefined()
  })

  it('passes the daemon baseUrl/token when the provider state is "daemon"', async () => {
    renderAppWithRouter(DAEMON_STATE, '/settings')
    await screen.findByTestId('settings-page')
    expect(receivedSettingsPageProps?.daemon).toEqual({
      baseUrl: DAEMON_STATE.kind === 'daemon' ? DAEMON_STATE.daemonBaseUrl : '',
      token: null,
    })
  })

  // Disconnecting (forcedBrowser=true) must drop workspaceId along with the
  // daemon prop — a mutation that instead kept passing the daemon's workspace
  // regardless of forcedBrowser would query the wrong keeper.
  it('drops the daemon once Settings disconnects from it', async () => {
    renderAppWithRouter(DAEMON_STATE, '/settings')
    await screen.findByTestId('settings-page')
    expect(receivedSettingsPageProps?.daemon).toBeDefined()
    const onDisconnected = receivedSettingsPageProps?.onDisconnected as () => void
    await act(async () => onDisconnected())
    expect(receivedSettingsPageProps?.daemon).toBeUndefined()
    expect(receivedSettingsPageProps?.workspaceId).toBeUndefined()
  })

  it('passes the daemon this page reconnected to through the extension', async () => {
    localStorage.clear()
    rememberDaemon(BRIDGE_DAEMON_BASE_URL)
    mockConnectResult = CONNECTED
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/settings']}>
          <App providerState={BROWSER_STATE} />
        </MemoryRouter>,
      )
    })
    await screen.findByTestId('settings-page')
    expect(receivedSettingsPageProps?.daemon).toEqual({
      baseUrl: BRIDGE_DAEMON_BASE_URL,
      token: '',
    })
    connectThroughExtensionMock.mockClear()
    mockConnectResult = { status: 'none' }
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
    await expectLoggedFailure('The above error occurred')
  })

  it('catches an error surfacing through the reconnected branch lazy path (boundary sits outside Suspense)', async () => {
    throwInDaemonDocumentPage = true
    localStorage.clear()
    rememberDaemon(BRIDGE_DAEMON_BASE_URL)
    mockConnectResult = CONNECTED
    const reportSpy = vi.spyOn(errorBoundaryLog, 'report').mockImplementation(() => {})
    try {
      render(
        <MemoryRouter initialEntries={['/w/w1/d/main']}>
          <App providerState={BROWSER_STATE} />
        </MemoryRouter>,
      )
      // The lazy module resolves after a microtask; the throw then propagates
      // through Suspense's error path to the boundary outside it.
      expect(await screen.findByText('Something went wrong')).toBeTruthy()
      expect(reportSpy).toHaveBeenCalled()
    } finally {
      throwInDaemonDocumentPage = false
      mockConnectResult = { status: 'none' }
      localStorage.clear()
      reportSpy.mockRestore()
    }
    await expectLoggedFailure('The above error occurred')
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
