/**
 * Pins the page-level half of the paired-session WS credential fix: the
 * default (non-injected) backend wiring must hand the page's pairing token
 * to DaemonBackend as `wsToken`. Without it, a pairing-grant session
 * authenticates every HTTP call but opens the WebSocket credential-less and
 * is rejected 401 — edits then silently stay browser-only while the page
 * looks connected. The backend-side half (which subprotocol the token is
 * offered on, bootstrap-global precedence) is pinned in
 * packages/mcp-server/src/shared/daemon-backend.ws-token.test.ts.
 */
import { act, cleanup, render as rtlRender, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { DaemonDocumentPage } from './DaemonDocumentPage.js'

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return {
    ...actual,
    listWorkspaces: vi.fn(),
    listDocuments: vi.fn(),
  }
})

// Captures constructor options without opening a real socket.
const constructed: { workspaceId: string; path: string; wsToken: string | undefined }[] = []
vi.mock('@kamiazya/whiteboard-mcp/daemon-backend', () => ({
  DaemonBackend: class {
    constructor(
      workspaceId: string,
      path: string,
      _locationHref: string,
      apiTransport?: { wsToken?: () => string | undefined },
    ) {
      constructed.push({ workspaceId, path, wsToken: apiTransport?.wsToken?.() })
    }
    connect(): void {}
    disconnect(): void {}
    pushLocalUpdate(): void {}
    getFile(): Promise<Blob | null> {
      return Promise.resolve(null)
    }
    putFile(): Promise<void> {
      return Promise.resolve()
    }
    sendClientReady(): void {}
    sendExportResponse(): void {}
  },
}))

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)

function MemoryRouterWrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/']}>{children}</MemoryRouter>
}

describe('DaemonDocumentPage default backend wiring', () => {
  beforeEach(() => {
    window.localStorage.clear()
    constructed.length = 0
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [{ path: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' }],
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('hands the pairing token to DaemonBackend as the WS credential', async () => {
    await act(async () => {
      rtlRender(
        <DaemonDocumentPage daemonBaseUrl="http://127.0.0.1:3099" token="pairing-session-token" />,
        { wrapper: MemoryRouterWrapper, container: document.body },
      )
    })
    await waitFor(() => expect(constructed.length).toBeGreaterThan(0))
    expect(constructed[0]).toMatchObject({
      workspaceId: 'w1',
      path: 'main',
      wsToken: 'pairing-session-token',
    })
  })
})
