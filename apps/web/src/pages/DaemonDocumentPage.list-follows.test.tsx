/**
 * The page's document list follows the workspace it is open in. A document an
 * agent creates, renames or edits while a canvas is open reaches the page as
 * an update to the workspace record it already syncs; the list every link,
 * reference and embed resolves against has to follow that update, not stay
 * as it was read at open.
 */

import type { DocumentSummary } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  updateWorkspaceDocumentMeta,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import {
  latestEditorProps,
  resetCapturedEditorProps,
} from '../test-utils/capturing-spatial-editor.js'
import { renderInRouter } from '../test-utils/daemon-page-harness.js'
import { jsonResponse } from '../test-utils/json-response.js'

const MAIN = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const PLAN = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

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

vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  const { CapturingSpatialEditor } = await import('../test-utils/capturing-spatial-editor.js')
  return { ...actual, SpatialEditor: CapturingSpatialEditor }
})

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')
const { useListFollowsRecord } = await import('./use-daemon-document-controller.js')

const mainRow: DocumentSummary = {
  path: 'main',
  documentId: MAIN,
  updatedAt: '2026-01-01',
  kind: 'spatial',
}
const planRow = (updatedAt: string): DocumentSummary => ({
  path: 'plan',
  documentId: PLAN,
  updatedAt,
  kind: 'markdown',
})

/** What the daemon's `/documents` answers from now on. */
function daemonLists(documents: DocumentSummary[]): void {
  vi.mocked(daemonApiClient.listDocuments).mockResolvedValue({ documents })
}

/** Writes on the daemon's record and hands the update to the page, as the fan-out does. */
function daemonWrites(write: (record: LoroDoc) => void): void {
  const record = daemon.record
  const handlers = daemon.handlers
  if (record === null || handlers === null) throw new Error('the page never connected')
  const from = record.oplogVersion()
  write(record)
  record.commit()
  handlers.onRemoteUpdate(record.export({ mode: 'update', from }))
}

const createsPlan = (record: LoroDoc) =>
  createWorkspaceDocumentAtPath(record, { path: 'plan', documentId: PLAN, kind: 'markdown' })

/** The snapshot reads the page's embed seam made for `plan`. */
const planLoads = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls.filter(([input]) => /\/plan\b.*snapshot/.test(String(input))).length

describe('DaemonDocumentPage document list follows the record', () => {
  let fetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetCapturedEditorProps()
    const record = new LoroDoc()
    createWorkspaceDocumentAtPath(record, { path: 'main', documentId: MAIN, kind: 'spatial' })
    writeSpatialCanvas(documentContainers(record, MAIN), {
      nodes: [fileNode({ id: 'n1', x: 0, y: 0, width: 200, height: 120, file: PLAN })],
      edges: [],
    })
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
    daemonLists([mainRow])
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  async function openMain(): Promise<void> {
    await act(async () => {
      renderInRouter(
        <DaemonDocumentPage daemonBaseUrl="http://127.0.0.1:3099" workspaceId="w1" path="main" />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(daemon.handlers).not.toBeNull())
    await waitFor(() => expect(latestEditorProps()?.missingFileRef).toBeDefined())
  }

  it('stops calling a document missing once an agent creates it', async () => {
    await openMain()
    expect(latestEditorProps()?.missingFileRef?.(PLAN)).toBe(true)

    daemonLists([mainRow, planRow('2026-01-02')])
    act(() => daemonWrites(createsPlan))

    await waitFor(() => expect(latestEditorProps()?.missingFileRef?.(PLAN)).toBe(false))
  })

  it('re-reads an embed when its document is edited elsewhere', async () => {
    const record = daemon.record as LoroDoc
    createsPlan(record)
    updateWorkspaceDocumentMeta(record, PLAN, { updatedAt: 1 })
    daemonLists([mainRow, planRow('2026-01-01')])
    await openMain()
    await waitFor(() => expect(planLoads(fetch)).toBeGreaterThan(0))
    const loads = planLoads(fetch)

    daemonLists([mainRow, planRow('2026-01-02')])
    act(() => daemonWrites((record) => updateWorkspaceDocumentMeta(record, PLAN, { updatedAt: 2 })))

    await waitFor(() => expect(planLoads(fetch)).toBeGreaterThan(loads))
  })

  it('keeps the newest list when an earlier read answers last', async () => {
    await openMain()
    let answerStale: (value: { documents: DocumentSummary[] }) => void = () => {}
    vi.mocked(daemonApiClient.listDocuments).mockImplementationOnce(
      () => new Promise((resolve) => (answerStale = resolve)),
    )
    const lists = vi.mocked(daemonApiClient.listDocuments).mock.calls.length
    act(() => daemonWrites(createsPlan))
    await waitFor(() =>
      expect(vi.mocked(daemonApiClient.listDocuments).mock.calls.length).toBe(lists + 1),
    )

    daemonLists([mainRow, planRow('2026-01-03')])
    act(() => daemonWrites((record) => updateWorkspaceDocumentMeta(record, PLAN, { updatedAt: 3 })))
    await waitFor(() => expect(latestEditorProps()?.missingFileRef?.(PLAN)).toBe(false))
    await act(async () => answerStale({ documents: [mainRow] }))

    expect(latestEditorProps()?.missingFileRef?.(PLAN)).toBe(false)
  })
})

describe('useListFollowsRecord', () => {
  let record: LoroDoc
  let peer: LoroDoc

  beforeEach(() => {
    vi.useFakeTimers()
    peer = new LoroDoc()
    createWorkspaceDocumentAtPath(peer, { path: 'main', documentId: MAIN, kind: 'spatial' })
    peer.commit()
    record = new LoroDoc()
    record.import(peer.export({ mode: 'snapshot' }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** A peer's write, imported into the followed record. */
  function peerWrites(target: LoroDoc, write: (doc: LoroDoc) => void): void {
    const from = peer.oplogVersion()
    write(peer)
    peer.commit()
    target.import(peer.export({ mode: 'update', from }))
  }

  /** Loro delivers `subscribe` events on a microtask, then the settle window runs. */
  async function settled(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
      vi.runOnlyPendingTimers()
    })
  }

  it('leaves the list alone for an import that changes no listed document', async () => {
    const refresh = vi.fn()
    renderHook(() => useListFollowsRecord({ doc: record }, refresh))

    peerWrites(record, (doc) =>
      writeSpatialCanvas(documentContainers(doc, MAIN), {
        nodes: [fileNode({ id: 'n1', x: 0, y: 0, width: 10, height: 10, file: PLAN })],
        edges: [],
      }),
    )
    await settled()
    expect(refresh).not.toHaveBeenCalled()

    peerWrites(record, createsPlan)
    await settled()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('re-reads once for a burst of imports inside the settle window', async () => {
    const refresh = vi.fn()
    renderHook(() => useListFollowsRecord({ doc: record }, refresh))

    peerWrites(record, createsPlan)
    peerWrites(record, (doc) => updateWorkspaceDocumentMeta(doc, PLAN, { updatedAt: 5 }))
    await settled()

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('compares a record a snapshot replaced against the one before it', async () => {
    const refresh = vi.fn()
    const { rerender } = renderHook(
      ({ doc }: { doc: LoroDoc }) => useListFollowsRecord({ doc }, refresh),
      { initialProps: { doc: record } },
    )
    createsPlan(peer)
    peer.commit()
    const replaced = new LoroDoc()
    replaced.import(peer.export({ mode: 'snapshot' }))

    rerender({ doc: replaced })
    await settled()

    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
