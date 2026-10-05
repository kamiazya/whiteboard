/**
 * The open note deleted somewhere else, on the daemon keeper — an agent's
 * `wb_workspace_edit`, another member, another tab. The delete reaches the
 * page as an ordinary update of the workspace record on the sync stream; the
 * page has to stop taking edits and say why.
 */

import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceDocument,
  documentContainers,
  writeCoreFacets,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { renderInRouter } from '../test-utils/daemon-page-harness.js'
import { jsonResponse } from '../test-utils/json-response.js'

const DOCUMENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

/** The daemon's copy of the workspace record, and the page's stream from it. */
const daemon = vi.hoisted(() => ({
  record: null as LoroDoc | null,
  handlers: null as DocumentBackendHandlers | null,
}))

vi.mock('@kamiazya/whiteboard-daemon-client/sse-backend', () => ({
  SseBackend: class {
    connect(handlers: DocumentBackendHandlers): void {
      daemon.handlers = handlers
      handlers.onConnected()
      if (daemon.record !== null) handlers.onSnapshot(daemon.record.export({ mode: 'snapshot' }))
    }
    disconnect(): void {}
    pushLocalUpdate(): void {}
    sendClientReady(): void {}
  },
}))

vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
    'createDocument',
  ]),
)

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

function seedRecord(): LoroDoc {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, {
    path: 'agent-note',
    documentId: DOCUMENT_ID,
    kind: 'markdown',
  })
  const containers = documentContainers(record, DOCUMENT_ID)
  writeMarkdownBody(containers, '# Before the delete')
  writeCoreFacets(containers, { type: 'markdown' })
  record.commit()
  return record
}

beforeEach(() => {
  daemon.record = seedRecord()
  daemon.handlers = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/names')) return jsonResponse({ documents: {}, pinned: [] })
      return jsonResponse({}, 404)
    }),
  )
  vi.mocked(daemonApiClient.listWorkspaces).mockResolvedValue({
    workspaces: [{ workspaceId: 'w1' }],
  })
  vi.mocked(daemonApiClient.listDocuments).mockResolvedValue({
    documents: [
      { path: 'agent-note', documentId: DOCUMENT_ID, updatedAt: '2026-01-01', kind: 'markdown' },
    ],
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  window.localStorage.clear()
})

it('a note deleted on the daemon says so, offers the way back, and stops taking edits', async () => {
  const onNavigateBack = vi.fn()
  await act(async () => {
    renderInRouter(
      <DaemonDocumentPage
        daemonBaseUrl="http://127.0.0.1:3099"
        workspaceId="w1"
        path="agent-note"
        onNavigateBack={onNavigateBack}
      />,
      { container: document.body },
    )
  })
  await waitFor(() => expect(document.body.textContent).toContain('Before the delete'))
  const editor = () => screen.getByTestId('markdown-source-wrap')
  expect(editor().closest('[inert]')).toBeNull()

  await act(async () => {
    const record = daemon.record as LoroDoc
    const from = record.oplogVersion()
    deleteWorkspaceDocument(record, { documentId: DOCUMENT_ID })
    daemon.handlers?.onRemoteUpdate(record.export({ mode: 'update', from }))
  })

  const notice = await screen.findByTestId('document-removed-notice')
  expect(notice.textContent).toContain('deleted elsewhere')
  const status = screen.getByTestId('restore-status')
  // The notice must outlive the lock: an inert subtree is hidden from
  // assistive technology, so a notice inside it would never be read.
  expect(status.closest('[inert]')).toBeNull()
  expect(editor().closest('[inert]')).not.toBeNull()
  within(status).getByRole('button', { name: 'Back to documents' }).click()
  expect(onNavigateBack).toHaveBeenCalledTimes(1)
})
