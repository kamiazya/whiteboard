/**
 * A daemon index route asked to open a folder reaches the address bar with its
 * `folder` query, which the document browser reads.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UserSettingsStore } from '../lib/user-settings-store.js'
import { useWorkspaceAddressSync } from './use-workspace-address-sync.js'

describe('useWorkspaceAddressSync folder', () => {
  it('navigates to the index with the folder query', () => {
    const navigate = vi.fn()
    renderHook((props) => useWorkspaceAddressSync(props), {
      initialProps: {
        location: { pathname: '/w/w1/d/notes/plan' } as ReturnType<
          typeof import('react-router-dom').useLocation
        >,
        navigate: navigate as unknown as ReturnType<typeof import('react-router-dom').useNavigate>,
        browserHandle: null,
        daemonKept: true,
        daemonView: { kind: 'index', workspace: 'w1', folder: 'notes' } as const,
        setDaemonView: vi.fn(),
        userSettingsStore: { load: () => ({ storage: {} }) } as unknown as UserSettingsStore,
        awaitingDaemonRenewal: false,
      },
    })
    expect(navigate).toHaveBeenCalledWith('/w/w1?folder=notes', expect.anything())
  })
})
