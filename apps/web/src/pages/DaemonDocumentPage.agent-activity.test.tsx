import { act, cleanup, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { FakeDocumentBackend, renderInRouter } from '../test-utils/daemon-page-harness.js'
import { DaemonDocumentPage } from './DaemonDocumentPage.js'

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
    'createDocument',
  ]),
)

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)

// The page's backend is captured so a test can push a server message in
// through the handlers it installed, as the daemon would. This is the join the
// unit tests cannot reach: `useAgentActivity` is proven on its own, and this
// proves the page actually subscribed it to `onAgentActivity`.
const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

describe('DaemonDocumentPage agent-activity wiring', () => {
  let backend: FakeDocumentBackend | null = null

  beforeEach(() => {
    backend = null
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [
        { path: 'main', documentId: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' },
      ],
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
      renderInRouter(
        <DaemonDocumentPage
          daemonBaseUrl={DAEMON_BASE_URL}
          createBackend={() => {
            backend = new FakeDocumentBackend()
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
        operator: { kind: 'ai', actor: 'process:daemon-1' },
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
        operator: { kind: 'ai', actor: 'process:daemon-1' },
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
