import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.js'
import type { ProviderState } from './lib/provider.js'

afterEach(cleanup)

// BrowserLocalCanvasPage pulls in Excalidraw/loro-crdt which need a real
// browser (roughjs native bindings, WASM). Mock it here since this suite
// only exercises the backend-configuration chip, not the canvas itself.
vi.mock('./pages/BrowserLocalCanvasPage.js', () => ({
  BrowserLocalCanvasPage: () => <div data-testid="browser-local-canvas-page" />,
}))

const BROWSER_LOCAL_STATE: ProviderState = {
  kind: 'browser-local',
  capabilities: {
    canvasReadWrite: true,
    migrationExport: true,
    migrationImport: false,
    workspaces: false,
    versions: false,
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

describe('App beta banner', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('shows the beta banner for browser-local and local-daemon states', () => {
    render(<App providerState={BROWSER_LOCAL_STATE} />)
    expect(
      screen.getByText('Beta preview — your data is stored only in this browser.'),
    ).toBeTruthy()
  })

  it('does not show the beta banner on the invalid-config error page', () => {
    render(<App providerState={INVALID_CONFIG_STATE} />)
    expect(
      screen.queryByText('Beta preview — your data is stored only in this browser.'),
    ).toBeNull()
  })
})
