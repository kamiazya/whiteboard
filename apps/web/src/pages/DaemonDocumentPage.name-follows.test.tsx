/**
 * The open document's title follows a name written elsewhere — the daemon
 * naming a note after the heading being typed, an agent's rename, another
 * tab's, another member's. Each reaches the page as an update to the
 * workspace record it already syncs, and `/names` is read once, at open.
 */

import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  setWorkspaceDocumentName,
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

/** Writes on the daemon's record and hands the update to the page, as the fan-out does. */
function daemonWrites(write: (record: LoroDoc) => void): void {
  const record = daemon.record
  const handlers = daemon.handlers
  if (record === null || handlers === null) throw new Error('the page never connected')
  const from = record.oplogVersion()
  write(record)
  handlers.onRemoteUpdate(record.export({ mode: 'update', from }))
}

const renamed = (name: string) => (record: LoroDoc) =>
  setWorkspaceDocumentName(record, { documentId: DOCUMENT_ID, name })

const titleBox = () => screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement

const namesReads = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls.filter(([input]) => String(input).includes('/names')).length

describe('DaemonDocumentPage title follows the record', () => {
  let fetch: ReturnType<typeof vi.fn>

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
    daemon.handlers = null
    fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/names')
        ? jsonResponse({ documents: {}, pinned: [] })
        : jsonResponse({}, 404),
    )
    vi.stubGlobal('fetch', fetch)
    vi.mocked(daemonApiClient.listWorkspaces).mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }],
    })
    vi.mocked(daemonApiClient.listDocuments).mockResolvedValue({
      documents: [
        { path: 'untitled', documentId: DOCUMENT_ID, updatedAt: '2026-01-01', kind: 'markdown' },
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
        />,
      )
    })
    await waitFor(() => expect(daemon.handlers).not.toBeNull())
    await waitFor(() => expect(titleBox().value).toBe('untitled'))
  }

  it('shows a name the daemon wrote to the record, without asking /names again', async () => {
    await openPage()
    const reads = namesReads(fetch)

    act(() => daemonWrites(renamed('Weekly review')))

    await waitFor(() => expect(titleBox().value).toBe('Weekly review'))
    expect(namesReads(fetch)).toBe(reads)
  })

  it('goes back to the path when the record clears the name', async () => {
    await openPage()
    act(() => daemonWrites(renamed('Weekly review')))
    await waitFor(() => expect(titleBox().value).toBe('Weekly review'))

    act(() =>
      daemonWrites((record) => setWorkspaceDocumentName(record, { documentId: DOCUMENT_ID })),
    )

    await waitFor(() => expect(titleBox().value).toBe('untitled'))
  })

  it('leaves a name being typed in the title box alone', async () => {
    await openPage()
    fireEvent.focus(titleBox())
    fireEvent.change(titleBox(), { target: { value: 'Mine' } })

    act(() => daemonWrites(renamed('Weekly review')))

    // The draft holds while the box is being edited; leaving it shows the
    // record's name, since this fake daemon refuses the rename.
    expect(titleBox().value).toBe('Mine')
    fireEvent.blur(titleBox())
    await waitFor(() => expect(titleBox().value).toBe('Weekly review'))
  })
})
