/**
 * The annotation layer, in daemon mode (ADR-0026 decision 5).
 *
 * The gap this closes is a KEEPER PARITY one, and it is the shape
 * `keeper-parity.test.ts` exists to catch: the rail was built on the browser
 * page and never mounted here, so a conversation on a daemon-kept document
 * was writable by an MCP peer — which is where most of them come from — and
 * reachable by nothing in the app. Decision 5 asks that a conversation be
 * reachable from any document; it did not say "from any document the browser
 * happens to keep".
 *
 * Nothing in this page's own suite would have noticed. The threads arrive on
 * `useDocumentSync`'s annotation channel exactly as they do in the browser,
 * so there is no failing call to find — only an absent one.
 *
 * jsdom, following this file's siblings: what is under test is the WIRING (do
 * the threads reach a mounted panel), and the panel's own interaction
 * behaviour has its own real-browser suite in
 * `components/annotations/CommentsPanel.browser.test.tsx`.
 */

import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { writeCommentThread, writeDocumentKind } from '@kamiazya/whiteboard-loro-adapter'
import { act, cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>, {
    container: document.body,
  })
}

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return { ...actual, listWorkspaces: vi.fn(), listDocuments: vi.fn(), createDocument: vi.fn() }
})

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)

/** A daemon-held spatial document carrying two conversations, one resolved. */
function snapshotWithThreads(): Uint8Array {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'spatial')
  writeCommentThread(doc, {
    id: 't-open',
    anchor: { kind: 'spatial', x: 20, y: 30 },
    status: 'open',
    messages: [{ id: 'm1', body: 'still needs a decision' }],
  })
  writeCommentThread(doc, {
    id: 't-done',
    anchor: { kind: 'spatial', x: 40, y: 50 },
    status: 'resolved',
    messages: [{ id: 'm2', body: 'settled last week' }],
  })
  return doc.export({ mode: 'snapshot' })
}

class FakeBackend implements DocumentBackend {
  connect(handlers: DocumentBackendHandlers): void {
    handlers.onConnected()
    handlers.onSnapshot(snapshotWithThreads())
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

async function mountPage(): Promise<void> {
  await act(async () => {
    render(
      <DaemonDocumentPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspaceId="w1"
        path="board"
        createBackend={() => new FakeBackend()}
      />,
    )
  })
}

describe('DaemonDocumentPage comments rail', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/names')) {
          return new Response(JSON.stringify({ documents: { board: 'Board' }, pinned: [] }), {
            status: 200,
          })
        }
        return new Response('{}', { status: 404 })
      }),
    )
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [{ path: 'board', id: 'id-board', updatedAt: '2026-01-01', kind: 'spatial' }],
    })
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('counts the open conversations on an opener, as the browser page does', async () => {
    await mountPage()

    // One of the two is resolved; counting both would report finished work as
    // outstanding. The count is also what makes the rail worth not opening —
    // the answer to "is there anything here" without taking the width.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /comments, 1 open/i })).toBeTruthy(),
    )
  })

  it('opens a rail listing this document conversations', async () => {
    await mountPage()

    const opener = await waitFor(() => screen.getByRole('button', { name: /comments/i }))
    // Closed by default, the same decision the browser page took: the panel
    // answers a question the reader asks.
    expect(screen.queryByTestId('comments-panel')).toBeNull()

    await act(async () => {
      opener.click()
    })

    // Scoped to the rail: the spatial editor draws the same conversation as a
    // bubble on the canvas, so an unscoped query matches twice and would pass
    // just as well with no rail mounted at all.
    const rail = await waitFor(() => screen.getByTestId('comments-panel'))
    await waitFor(() => expect(within(rail).getByText('still needs a decision')).toBeTruthy())
    // Resolved is one filter away, not on screen by default.
    expect(within(rail).queryByText('settled last week')).toBeNull()
  })
})
