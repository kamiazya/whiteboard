/**
 * S10 root cause: on a cold load of a daemon-workspace deep link
 * (`/w/<daemon-ws>/d/<path>`) served from a hosted 'browser' provider, the
 * silent daemon renewal (App's `attemptRenewal`, a real network round trip)
 * has not resolved yet when this hook's browser-keeper effect first runs.
 * `daemonKept` is still false at that point — it can only become true once
 * the renewal lands — so the effect concludes the address names a workspace
 * this (browser) keeper does not hold and rewrites the URL to the browser's
 * own index, via `switchBrowserWorkspace`/`rewrite()`. That clobbers
 * `daemonView` (through the URL -> state effect) before the renewal ever
 * gets a chance to prove the address WAS the daemon's — so the page that
 * finally mounts is the gallery, not the document, and the replica pull
 * this ticket is about never has a page to run from at all.
 *
 * `awaitingDaemonRenewal` closes the race: while a renewal for a stored
 * daemon connection is still outstanding, an address that does not (yet)
 * match this browser's own workspace is UNDECIDED, not foreign — the same
 * standing the effect already gives a known replica address, one guard up.
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserSettingsStore } from '../lib/user-settings-store.js'
import { useWorkspaceAddressSync } from './use-workspace-address-sync.js'

const { switchBrowserWorkspaceMock, browserWorkspaceMatchesMock } = vi.hoisted(() => ({
  switchBrowserWorkspaceMock: vi.fn(),
  browserWorkspaceMatchesMock: vi.fn(),
}))
vi.mock('../lib/browser-workspace-id.js', () => ({
  browserWorkspaceMatches: browserWorkspaceMatchesMock,
  switchBrowserWorkspace: switchBrowserWorkspaceMock,
}))

const { findReplicaForHandleMock } = vi.hoisted(() => ({ findReplicaForHandleMock: vi.fn() }))
vi.mock('../lib/replicas.js', () => ({ findReplicaForHandle: findReplicaForHandleMock }))

const DAEMON_WORKSPACE = '01M313GVJNQPD2V0280E8SKNGF'
const daemonDocPath = `/w/${DAEMON_WORKSPACE}/d/moved-note`

function baseProps(overrides: Partial<Parameters<typeof useWorkspaceAddressSync>[0]> = {}) {
  return {
    location: { pathname: daemonDocPath } as ReturnType<
      typeof import('react-router-dom').useLocation
    >,
    navigate: vi.fn() as unknown as ReturnType<typeof import('react-router-dom').useNavigate>,
    isPairRoute: false,
    browserHandle: 'default',
    daemonKept: false,
    daemonView: { kind: 'document', workspace: DAEMON_WORKSPACE, path: 'moved-note' } as const,
    setDaemonView: vi.fn(),
    userSettingsStore: { load: () => ({ storage: {} }) } as unknown as UserSettingsStore,
    awaitingDaemonRenewal: false,
    ...overrides,
  }
}

describe('useWorkspaceAddressSync — a stored daemon connection whose renewal has not settled yet', () => {
  beforeEach(() => {
    switchBrowserWorkspaceMock.mockReset().mockResolvedValue(null)
    browserWorkspaceMatchesMock.mockReset().mockReturnValue(false)
    findReplicaForHandleMock.mockReset().mockReturnValue(null)
  })

  it('does not claim a daemon-workspace address for the browser keeper while the renewal is still in flight', () => {
    renderHook((props) => useWorkspaceAddressSync(props), {
      initialProps: baseProps({ awaitingDaemonRenewal: true }),
    })
    expect(switchBrowserWorkspaceMock).not.toHaveBeenCalled()
  })

  it('still rewrites a genuinely browser-only address once the renewal has settled (no stored daemon, or it refused)', async () => {
    switchBrowserWorkspaceMock.mockResolvedValue(null)
    renderHook((props) => useWorkspaceAddressSync(props), {
      initialProps: baseProps({ awaitingDaemonRenewal: false }),
    })
    expect(switchBrowserWorkspaceMock).toHaveBeenCalledWith(DAEMON_WORKSPACE)
  })
})
