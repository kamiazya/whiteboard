import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeeperNotices } from '../components/connection/KeeperNotices.js'
import { isSyncOff } from '../lib/connection-state.js'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { nothingHeldInTab } from '../lib/nothing-held-in-tab.js'
import { getShellConnection } from '../lib/shell-status-store.js'
import { stubAppBadge } from '../test-utils/app-badge.js'
import { FakeDocumentBackend, renderWithRouterWrapper } from '../test-utils/daemon-page-harness.js'
import { DaemonDocumentPage } from './DaemonDocumentPage.js'

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)
vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
  ]),
)

// A load that failed built no session and mounted no editor, so nothing can
// have been typed here: the shell still reads sync-off, but no tab-wide
// signal claims the user's work is held in this tab alone.
describe('a daemon page whose load failed before any session', () => {
  let badge: ReturnType<typeof stubAppBadge>

  beforeEach(() => {
    badge = stubAppBadge()
    vi.mocked(daemonApiClient.listWorkspaces).mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }],
    })
    vi.mocked(daemonApiClient.listDocuments).mockRejectedValue(new Error('daemon answered 500'))
  })

  afterEach(() => {
    cleanup()
    badge.restore()
  })

  it('reads sync-off but holds nothing in the tab', async () => {
    await act(async () => {
      renderWithRouterWrapper(
        <>
          <KeeperNotices />
          <DaemonDocumentPage
            daemonBaseUrl="http://127.0.0.1:3099"
            workspaceId="w1"
            path="main"
            createBackend={() => new FakeDocumentBackend()}
          />
        </>,
        { container: document.body },
      )
    })
    await screen.findByText(/daemon answered 500/)
    await waitFor(() => {
      const state = getShellConnection()?.state
      expect(state !== undefined && isSyncOff(state)).toBe(true)
    })

    const leaving = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leaving)
    expect(leaving.defaultPrevented).toBe(false)
    expect(badge.set).not.toHaveBeenCalled()
    expect(nothingHeldInTab()).toBe(true)
  })
})
