/**
 * ADR-0047: a server-mode keeper serves this page from its own origin and
 * has no WebSocket, and no replica routes. The page syncs over SSE there and
 * keeps nothing of the server's in this browser.
 */
import { cleanup, render as rtlRender, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import * as replicaRefresh from '../lib/replica-refresh.js'
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

const built: string[] = []

vi.mock('@kamiazya/whiteboard-daemon-client/sse-backend', async () =>
  (await import('../test-utils/daemon-page-harness.js')).fakeSseBackendModule({
    onConstruct: () => built.push('sse'),
  }),
)

function Wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/']}>{children}</MemoryRouter>
}

describe('DaemonDocumentPage served by a server-mode keeper', () => {
  beforeEach(() => {
    built.length = 0
    vi.mocked(daemonApiClient.listWorkspaces).mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }],
    })
    vi.mocked(daemonApiClient.listDocuments).mockResolvedValue({
      documents: [
        { path: 'main', documentId: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' },
      ],
    })
    vi.mocked(replicaRefresh.scheduleReplicaPush).mockClear()
    vi.mocked(replicaRefresh.scheduleReplicaRefresh).mockClear()
  })
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it('syncs over SSE, the transport the keeper has', async () => {
    rtlRender(<DaemonDocumentPage daemonBaseUrl={window.location.origin} serverMode />, {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(built).toContain('sse'))
  })

  it("keeps no replica of the server's workspace in this browser", async () => {
    rtlRender(<DaemonDocumentPage daemonBaseUrl={window.location.origin} serverMode />, {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(built.length).toBeGreaterThan(0))
    expect(replicaRefresh.scheduleReplicaPush).not.toHaveBeenCalled()
    expect(replicaRefresh.scheduleReplicaRefresh).not.toHaveBeenCalled()
  })

  // The control: the same page for a paired daemon still reconciles its replica,
  // so the case above is about serverMode and not about the fixture.
  it('still reconciles the replica of a paired daemon', async () => {
    rtlRender(<DaemonDocumentPage daemonBaseUrl="http://127.0.0.1:3099" token="t" />, {
      wrapper: Wrapper,
    })
    await waitFor(() => expect(replicaRefresh.scheduleReplicaRefresh).toHaveBeenCalled())
  })
})
