import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.js'
import { errorBoundaryLog } from './components/ErrorBoundary.js'
import type { DaemonConnectionResult } from './hooks/useDaemonConnection.js'
import type { ProviderState, WhiteboardCapabilities } from './lib/provider.js'

afterEach(cleanup)

// Records the props BrowserLocalCanvasPage receives so tests can assert
// capabilities actually flow from App down to the page, not just that the
// page mounts. BrowserLocalCanvasPage pulls in Excalidraw/loro-crdt which
// need a real browser (roughjs native bindings, WASM), so it stays mocked.
let receivedCapabilities: WhiteboardCapabilities | undefined
// Toggled by the error-boundary test to force the mocked page to throw
// during render, so App's ErrorBoundary wiring has something real to catch.
let throwInBrowserLocalCanvasPage = false
vi.mock('./pages/BrowserLocalCanvasPage.js', () => ({
  BrowserLocalCanvasPage: ({ capabilities }: { capabilities?: WhiteboardCapabilities }) => {
    receivedCapabilities = capabilities
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
vi.mock('./pages/DaemonCanvasPage.js', () => ({
  DaemonCanvasPage: (props: Record<string, unknown>) => {
    receivedDaemonPageProps = props
    return <div data-testid="daemon-canvas-page" />
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
    render(<App providerState={BROWSER_LOCAL_STATE} />)
    expect(screen.getByText('Browser only')).toBeTruthy()
  })

  it('shows the daemon URL when configured for a local daemon', () => {
    render(<App providerState={LOCAL_DAEMON_STATE} />)
    expect(screen.getByText('Configured for local daemon at http://127.0.0.1:3000')).toBeTruthy()
  })

  it('does not render the chip on the invalid-config error page', () => {
    render(<App providerState={INVALID_CONFIG_STATE} />)
    expect(screen.queryByText('Browser only')).toBeNull()
    expect(screen.queryByText(/Configured for local daemon/)).toBeNull()
  })
})

describe('App capability wiring', () => {
  beforeEach(() => {
    receivedCapabilities = undefined
  })

  it('passes the browser-local capabilities down to BrowserLocalCanvasPage', () => {
    render(<App providerState={BROWSER_LOCAL_STATE} />)
    expect(receivedCapabilities).toEqual(BROWSER_LOCAL_STATE.capabilities)
  })
})

describe('App beta banner', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('shows the browser-only persistence copy for the browser-local state', () => {
    render(<App providerState={BROWSER_LOCAL_STATE} />)
    expect(
      screen.getByText('Beta preview — your data is stored only in this browser.'),
    ).toBeTruthy()
  })

  it('shows daemon-neutral copy for the local-daemon state (no browser-only claim)', () => {
    render(<App providerState={LOCAL_DAEMON_STATE} />)
    expect(screen.getByText('Beta preview — features may be incomplete.')).toBeTruthy()
    expect(
      screen.queryByText('Beta preview — your data is stored only in this browser.'),
    ).toBeNull()
  })

  it('does not show the beta banner on the invalid-config error page', () => {
    render(<App providerState={INVALID_CONFIG_STATE} />)
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
    render(<App providerState={BROWSER_LOCAL_STATE} />)
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
    render(<App providerState={BROWSER_LOCAL_STATE} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    const button = screen.getByRole('button', { name: /continue in browser-local/i })
    expect(button).toBeTruthy()
    fireEvent.click(button)
    expect(screen.getByTestId('browser-local-canvas-page')).toBeTruthy()
  })

  it('falls through to existing provider-state resolution unchanged when there is no fragment', () => {
    mockDaemonConnectionResult = { status: 'none' }
    render(<App providerState={BROWSER_LOCAL_STATE} />)
    expect(screen.getByTestId('browser-local-canvas-page')).toBeTruthy()
    expect(screen.queryByTestId('daemon-canvas-page')).toBeNull()
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
    render(<App providerState={BROWSER_LOCAL_STATE} />)
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('Something went wrong')).toBeTruthy()
    expect(reportSpy).toHaveBeenCalled()
    reportSpy.mockRestore()
  })
})
