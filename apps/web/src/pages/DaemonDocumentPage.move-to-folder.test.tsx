/**
 * Filing the open daemon-kept document from its own menu: "Move to folder…"
 * asks the daemon to move it, and the page follows it to the new address.
 */

import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeCoreFacets,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
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

describe('DaemonDocumentPage Move to folder', () => {
  let fetch: ReturnType<typeof vi.fn>
  let onPathMoved: ReturnType<typeof vi.fn<(path: string) => void>>

  beforeEach(() => {
    const record = new LoroDoc()
    createWorkspaceDocumentAtPath(record, {
      path: 'untitled',
      documentId: DOCUMENT_ID,
      kind: 'markdown',
    })
    const containers = documentContainers(record, DOCUMENT_ID)
    writeMarkdownBody(containers, 'body')
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
        { path: 'unit/plan', documentId: 'other', updatedAt: '2026-01-01', kind: 'markdown' },
      ],
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  // A ceiling, not a delay: 1.1s alone, 5.4s measured inside a loaded run of
  // the whole pages directory, past the 5s default.
  it('moves the open note into the folder picked from its menu and follows it', {
    timeout: 15_000,
  }, async () => {
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
    fireEvent.pointerDown(await screen.findByLabelText('More actions'), { button: 0 })
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Move to folder…' }, { timeout: 5000 }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'Move to folder' }, { timeout: 5000 })
    fireEvent.click(await within(dialog).findByRole('option', { name: 'unit' }))

    await waitFor(() => expect(onPathMoved).toHaveBeenCalledWith('unit/untitled'), {
      timeout: 5000,
    })
    const moves = fetch.mock.calls.filter(
      ([input, init]) => init?.method === 'PUT' && String(input).endsWith('/untitled/path'),
    )
    expect(moves.map(([, init]) => JSON.parse(String(init?.body)).path)).toEqual(['unit/untitled'])
  })
})
