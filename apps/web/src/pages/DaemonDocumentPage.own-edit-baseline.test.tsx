/**
 * The document list's "changed since you last opened it" dot must not light
 * for an edit the person made themself, and must for one that arrived from
 * elsewhere. The page is where the two are told apart: it hands the session
 * the writer of the seen baseline for the document it has open.
 */
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { daemonMemoryScope } from '../components/workspace-files/use-device-memory.js'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { contentStateOf } from '../lib/document-state.js'
import { readSeenDigest, recordSeenDocument } from '../lib/seen-documents.js'
import {
  latestEditorProps,
  resetCapturedEditorProps,
} from '../test-utils/capturing-spatial-editor.js'
import { FakeDocumentBackend, MemoryRouterWrapper } from '../test-utils/daemon-page-harness.js'
import { DaemonDocumentPage } from './DaemonDocumentPage.js'

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)
vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
  ]),
)
vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  const { CapturingSpatialEditor } = await import('../test-utils/capturing-spatial-editor.js')
  return { ...actual, SpatialEditor: CapturingSpatialEditor }
})

const BASE_URL = 'http://127.0.0.1:3099'
const SCOPE = daemonMemoryScope(BASE_URL, { workspaceId: 'w1' })
const OPENED_AT = 'digest-at-open'

let backend: FakeDocumentBackend | null = null

async function openDocument(): Promise<FakeDocumentBackend> {
  await act(async () => {
    rtlRender(
      <DaemonDocumentPage
        daemonBaseUrl={BASE_URL}
        createBackend={() => {
          backend = new FakeDocumentBackend()
          return backend
        }}
      />,
      { wrapper: MemoryRouterWrapper, container: document.body },
    )
  })
  await waitFor(() => expect(screen.getByTestId('stub-spatial-editor')).toBeTruthy())
  if (backend === null) throw new Error('the page created no backend')
  return backend
}

describe('DaemonDocumentPage seen baseline', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetCapturedEditorProps()
    backend = null
    recordSeenDocument(SCOPE, 'id-main', OPENED_AT)
    vi.mocked(daemonApiClient.listWorkspaces).mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }],
    })
    vi.mocked(daemonApiClient.listDocuments).mockResolvedValue({
      documents: [
        { path: 'main', documentId: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' },
      ],
    })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('moves the baseline to the state the person’s own edit left', async () => {
    const opened = await openDocument()
    const node = textNode({ id: 'n-a', x: 0, y: 0, width: 100, height: 40, text: 'A' })
    await act(async () => {
      latestEditorProps()?.onChange?.({ nodes: [node], edges: [] }, { kind: 'create-node', node })
    })
    await waitFor(() => expect(opened.pushed.length).toBeGreaterThan(0))

    const replay = new LoroDoc()
    replay.import(opened.snapshot)
    for (const update of opened.pushed) replay.import(update)
    await waitFor(() => expect(readSeenDigest(SCOPE, 'id-main')).toBe(contentStateOf(replay)))
    expect(readSeenDigest(SCOPE, 'id-main')).not.toBe(OPENED_AT)
  })

  it('leaves the baseline alone when the change arrived from elsewhere', async () => {
    const opened = await openDocument()
    const peer = new LoroDoc()
    peer.import(opened.snapshot)
    writeSpatialCanvas(peer, {
      nodes: [textNode({ id: 'n-r', x: 0, y: 0, width: 100, height: 40, text: 'remote' })],
      edges: [],
    })
    await act(async () => {
      opened.handlers?.onRemoteUpdate?.(peer.export({ mode: 'update' }))
    })

    expect(readSeenDigest(SCOPE, 'id-main')).toBe(OPENED_AT)
  })
})
