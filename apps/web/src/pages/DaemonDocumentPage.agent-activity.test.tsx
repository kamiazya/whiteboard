import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, cleanup, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_HIGHLIGHT_MS } from '../hooks/use-agent-activity.js'
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

function twoNodesJoinedByAnEdge(): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [
      textNode({ id: 'a', x: 0, y: 0, width: 120, height: 60, text: 'left' }),
      textNode({ id: 'b', x: 400, y: 0, width: 120, height: 60, text: 'right' }),
    ],
    edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' } }],
  })
  return doc.export({ mode: 'snapshot' })
}

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

  async function mountPage(seed?: () => Uint8Array): Promise<void> {
    await act(async () => {
      renderInRouter(
        <DaemonDocumentPage
          daemonBaseUrl={DAEMON_BASE_URL}
          createBackend={() => {
            backend = new FakeDocumentBackend(seed)
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

  it('outlines an edge an agent touched when no node was', async () => {
    // An edge-only edit (a relabel, a recolour) reaches the browser as
    // `touched: { nodes: [], edges: [...] }`; outlining nodes alone left such
    // an edit with no cue on the board.
    await mountPage(twoNodesJoinedByAnEdge)
    await waitFor(() =>
      expect(document.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
        'right',
      ),
    )

    await act(async () => {
      backend?.handlers?.onAgentActivity?.({
        operator: { kind: 'ai', actor: 'process:daemon-1' },
        touched: { nodes: [], edges: ['e1'] },
        summary: 'relabelled 1 edge',
      })
    })

    const outlines = document.querySelector('[data-testid="agent-touch-outlines"]')
    expect(outlines?.querySelector('polyline[data-edge-id="e1"]')).toBeTruthy()
    expect(outlines?.querySelectorAll('rect')).toHaveLength(0)
  })

  it('lets the edge outline fade with the node outline', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mountPage(twoNodesJoinedByAnEdge)
    await waitFor(() =>
      expect(document.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
        'right',
      ),
    )

    await act(async () => {
      backend?.handlers?.onAgentActivity?.({
        operator: { kind: 'ai', actor: 'process:daemon-1' },
        touched: { nodes: [], edges: ['e1'] },
        summary: 'relabelled 1 edge',
      })
    })
    expect(document.querySelector('[data-testid="agent-touch-outlines"]')).toBeTruthy()

    await act(async () => {
      vi.advanceTimersByTime(AGENT_HIGHLIGHT_MS + 100)
    })

    expect(document.querySelector('[data-testid="agent-touch-outlines"]')).toBeNull()
  })
})
