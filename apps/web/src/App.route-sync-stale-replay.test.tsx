/**
 * The dev-mode `#wb=` route-sync bug, pinned deterministically: a real
 * router propagates navigation into `useLocation` ASYNCHRONOUSLY, so under
 * StrictMode's effect replay the URL->state sync effect used to run a
 * second time against the STALE pre-navigation pathname ('/'), overwrite
 * the payload-derived canvas view with 'index', and (in a live browser)
 * the two sync effects then chased each other's one-step-old snapshots
 * forever — remounting DaemonDocumentPage and reopening its WebSocket ~170
 * times per second against a real daemon.
 *
 * MemoryRouter cannot reproduce this (act() flushes its state before the
 * replay runs) and vitest's browser mode cannot host a real BrowserRouter
 * (rewriting the iframe URL severs the runner), so this harness fakes only
 * the two router hooks App uses, with the one property that matters:
 * navigation reaches `useLocation` on a later tick.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderState } from './lib/provider.js'

interface FakeLocation {
  pathname: string
  search: string
  hash: string
  state: unknown
  key: string
}

let fakeLocation: FakeLocation = { pathname: '/', search: '', hash: '', state: null, key: 'k0' }
const listeners = new Set<() => void>()
const navigateCalls: string[] = []
let keySeq = 0

function fakeNavigate(to: string): void {
  navigateCalls.push(to)
  if (navigateCalls.length > 25) {
    throw new Error(`route-sync ping-pong: ${navigateCalls.length} navigations`)
  }
  // The property under test: the pathname reaches useLocation on a LATER
  // tick, exactly as a real browser router behaves — an effect replay that
  // runs before this fires sees the stale pre-navigation location.
  setTimeout(() => {
    keySeq += 1
    fakeLocation = { ...fakeLocation, pathname: to, key: `k${keySeq}` }
    for (const listener of listeners) listener()
  }, 0)
}

vi.mock('react-router-dom', () => ({
  useLocation: () =>
    useSyncExternalStore(
      (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      () => fakeLocation,
    ),
  useNavigate: () => fakeNavigate,
}))

let indexPageMounts = 0
vi.mock('./pages/DaemonDocumentPage.js', () => ({
  DaemonDocumentPage: () => <div data-testid="daemon-document-page" />,
}))
vi.mock('./pages/DaemonIndexPage.js', () => ({
  DaemonIndexPage: () => {
    indexPageMounts += 1
    return <div data-testid="daemon-index-page" />
  },
}))
// The shell renders router-coupled chrome (Link) that the two-hook fake
// router cannot host; the shell is not this test's subject.
vi.mock('./components/AppShell.js', () => ({
  AppShell: () => <div data-testid="mock-shell" />,
  default: () => <div data-testid="mock-shell" />,
}))
vi.mock('./hooks/useDaemonConnection.js', () => ({
  useDaemonConnection: () => ({
    status: 'paired',
    payload: {
      baseUrl: 'http://127.0.0.1:3099',
      workspaceId: 'w1',
      path: 'main',
      authMode: 'bootstrap',
      bootstrapToken: 'tok-123456',
    },
  }),
}))

const { App } = await import('./App.js')

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

describe('App route sync against an asynchronously-propagating router', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fakeLocation = { pathname: '/', search: '', hash: '', state: null, key: 'k0' }
    navigateCalls.length = 0
    indexPageMounts = 0
    window.localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    window.localStorage.clear()
  })

  it('a StrictMode replay must not overwrite the #wb= canvas view with the stale pathname', async () => {
    render(
      <StrictMode>
        <App providerState={BROWSER_LOCAL_STATE} />
      </StrictMode>,
    )
    // Drain the navigation timers until the system settles (or the storm
    // guard in fakeNavigate throws).
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        vi.runAllTimers()
      })
    }
    expect(screen.getByTestId('daemon-document-page')).toBeTruthy()
    expect(fakeLocation.pathname).toBe('/w/w1/canvas/main')
    // The payload said "open this canvas": the gallery must never flash in,
    // and one navigation ('/' -> canvas URL) is all the sync needs.
    expect(indexPageMounts).toBe(0)
    expect(navigateCalls).toEqual(['/w/w1/canvas/main'])
  })
})
