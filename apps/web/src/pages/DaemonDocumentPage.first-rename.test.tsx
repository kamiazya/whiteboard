/**
 * Naming a daemon-kept document for the first time moves it from its generated
 * path to the name's, once; every later rename leaves the path alone.
 */

import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeCoreFacets,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { renderInRouter } from '../test-utils/daemon-page-harness.js'
import { jsonResponse } from '../test-utils/json-response.js'

const DOCUMENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const render = (ui: ReactElement) => renderInRouter(ui, { container: document.body })

vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
  ]),
)

/** The daemon's copy of the workspace record, and the stream it fans out on. */
const daemon = vi.hoisted(() => ({
  record: null as LoroDoc | null,
  handlers: null as DocumentBackendHandlers | null,
}))

vi.mock('@kamiazya/whiteboard-daemon-client/sse-backend', () => ({
  SseBackend: class {
    connect(handlers: DocumentBackendHandlers): void {
      daemon.handlers = handlers
      handlers.onConnected()
      handlers.onSnapshot(daemon.record?.export({ mode: 'snapshot' }) ?? new Uint8Array())
    }
    disconnect(): void {}
    pushLocalUpdate(): void {}
    sendClientReady(): void {}
  },
}))

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const titleBox = () => screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement

describe('DaemonDocumentPage first rename', () => {
  let fetch: ReturnType<typeof vi.fn>
  let onPathMoved: ReturnType<typeof vi.fn<(path: string) => void>>
  const calls = () =>
    fetch.mock.calls.map(([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`)

  beforeEach(() => {
    const record = new LoroDoc()
    createWorkspaceDocumentAtPath(record, {
      path: 'untitled',
      documentId: DOCUMENT_ID,
      kind: 'markdown',
    })
    const containers = documentContainers(record, DOCUMENT_ID)
    writeMarkdownBody(containers, '')
    writeCoreFacets(containers, { type: 'markdown' })
    record.commit()
    daemon.record = record
    onPathMoved = vi.fn<(path: string) => void>()
    fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'PUT' && url.endsWith('/path')) {
        return jsonResponse({ path: JSON.parse(String(init.body)).path })
      }
      return url.includes('/names') || url.endsWith('/name')
        ? jsonResponse({ documents: {}, pinned: [] })
        : jsonResponse({}, 404)
    })
    vi.stubGlobal('fetch', fetch)
    vi.mocked(daemonApiClient.listWorkspaces).mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }],
    })
    vi.mocked(daemonApiClient.listDocuments).mockResolvedValue({
      documents: [
        { path: 'untitled', documentId: DOCUMENT_ID, updatedAt: '2026-01-01', kind: 'markdown' },
        { path: 'roadmap', documentId: 'other', updatedAt: '2026-01-01', kind: 'markdown' },
      ],
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  async function openPage(): Promise<void> {
    await act(async () => {
      render(
        <DaemonDocumentPage
          daemonBaseUrl="http://127.0.0.1:3099"
          workspaceId="w1"
          path="untitled"
          onPathMoved={onPathMoved}
        />,
      )
    })
    await waitFor(() => expect(titleBox().value).toBe('untitled'))
  }

  function typeAndLeave(text: string): void {
    fireEvent.focus(titleBox())
    for (let i = 1; i <= text.length; i++) {
      fireEvent.change(titleBox(), { target: { value: text.slice(0, i) } })
    }
    fireEvent.blur(titleBox())
  }

  it("moves the document to the name's path after the name is written, and says where", async () => {
    await openPage()
    typeAndLeave('Checkout Architecture')

    await waitFor(
      () =>
        expect(onPathMoved, calls().slice(-4).join('\n')).toHaveBeenCalledWith(
          'checkout-architecture',
        ),
      { timeout: 3000 },
    )
    const sent = calls()
    const move = sent.findIndex(
      (c) => c.startsWith('PUT') && c.endsWith('/documents/untitled/path'),
    )
    expect(move).toBeGreaterThan(-1)
    // Every name write went to the address that still held the document.
    const lastNameWrite = sent.map((c) => c.endsWith('/untitled/name')).lastIndexOf(true)
    expect(lastNameWrite).toBeGreaterThan(-1)
    expect(lastNameWrite).toBeLessThan(move)
  })

  it('numbers the address when a sibling already holds it', async () => {
    await openPage()
    typeAndLeave('Roadmap')
    await waitFor(() => expect(onPathMoved).toHaveBeenCalledWith('roadmap-2'))
  })

  it('does not move when the daemon refused the name', async () => {
    fetch.mockImplementation(async () => jsonResponse({}, 404))
    await openPage()
    typeAndLeave('Checkout Architecture')
    await screen.findByRole('alert')
    expect(onPathMoved).not.toHaveBeenCalled()
    expect(calls().some((c) => c.endsWith('/path'))).toBe(false)
  })

  it('does not move while the name is still being typed', async () => {
    await openPage()
    fireEvent.focus(titleBox())
    fireEvent.change(titleBox(), { target: { value: 'Ch' } })
    await waitFor(() => expect(calls().some((c) => c.endsWith('/untitled/name'))).toBe(true))
    expect(onPathMoved).not.toHaveBeenCalled()
    expect(calls().some((c) => c.endsWith('/path'))).toBe(false)
  })
})
