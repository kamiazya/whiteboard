import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  act,
  cleanup,
  type RenderOptions,
  render as rtlRender,
  waitFor,
} from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { DaemonDocumentPage } from './DaemonDocumentPage.js'

function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>, options)
}

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return {
    ...actual,
    listWorkspaces: vi.fn(),
    listDocuments: vi.fn(),
    createDocument: vi.fn(),
  }
})

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)

/**
 * Captures the handler bundle the page installs, so a test can push a
 * server message in as the daemon would. This is the join the unit tests
 * cannot reach: `useAgentActivity` is proven on its own, and this proves the
 * page actually subscribed it to `onAgentActivity`.
 */
class FakeBackend implements DocumentBackend {
  handlers: DocumentBackendHandlers | null = null
  constructor(
    public workspaceId: string,
    public path: string,
  ) {}
  connect(handlers: DocumentBackendHandlers): void {
    this.handlers = handlers
    handlers.onConnected()
    handlers.onSnapshot(new LoroDoc().export({ mode: 'snapshot' }))
  }
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
}

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

describe('DaemonDocumentPage agent-activity wiring', () => {
  let backend: FakeBackend | null = null

  beforeEach(() => {
    backend = null
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [{ path: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' }],
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    vi.useRealTimers()
    localStorage.clear()
  })

  async function mountPage(): Promise<void> {
    await act(async () => {
      render(
        <DaemonDocumentPage
          daemonBaseUrl={DAEMON_BASE_URL}
          createBackend={(workspaceId, path) => {
            backend = new FakeBackend(workspaceId, path)
            return backend
          }}
        />,
        { container: document.body },
      )
    })
    await waitFor(() =>
      expect(document.querySelector('[data-testid="spatial-editor-container"]')).toBeTruthy(),
    )
  }

  it('shows nothing until an agent actually does something', async () => {
    await mountPage()

    expect(document.querySelector('[data-testid="agent-presence-chip"]')).toBeNull()
  })

  it('announces an agent edit, and says what it did', async () => {
    await mountPage()

    await act(async () => {
      backend?.handlers?.onAgentActivity?.({
        operator: { kind: 'ai', peerId: 'daemon-1' },
        touched: { nodes: ['a'], edges: [] },
        summary: 'added 3, tidied the layout',
      })
    })

    const chip = document.querySelector('[data-testid="agent-presence-chip"]')
    expect(chip).toBeTruthy()
    expect(chip?.textContent).toContain('added 3, tidied the layout')
    // A human who is not looking at the canvas still needs to be told.
    expect(chip?.getAttribute('role')).toBe('status')
    expect(chip?.getAttribute('aria-live')).toBe('polite')
  })

  it('lets the announcement lapse on its own', async () => {
    // Nothing ever says "the agent is done" — the server sends one message
    // per batch and no more. Without the lapse, a crashed agent would leave
    // this chip up until the tab was reloaded.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mountPage()

    await act(async () => {
      backend?.handlers?.onAgentActivity?.({
        operator: { kind: 'ai', peerId: 'daemon-1' },
        touched: { nodes: ['a'], edges: [] },
        summary: 'added 1',
      })
    })
    expect(document.querySelector('[data-testid="agent-presence-chip"]')).toBeTruthy()

    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })

    expect(document.querySelector('[data-testid="agent-presence-chip"]')).toBeNull()
  })
})
