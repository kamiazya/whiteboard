import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
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

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)

class FakeBackend extends FakeDocumentBackend {
  constructor(
    public workspaceId: string,
    public path: string,
  ) {
    super()
    createdBackends.push(this)
  }
}

const createdBackends: FakeBackend[] = []

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

async function renderPage() {
  await act(async () => {
    rtlRender(
      <DaemonDocumentPage
        daemonBaseUrl={DAEMON_BASE_URL}
        createBackend={(workspaceId, path) => new FakeBackend(workspaceId, path)}
      />,
      { wrapper: MemoryRouterWrapper, container: document.body },
    )
  })
  await waitFor(() => expect(screen.getByTestId('stub-spatial-editor')).toBeTruthy())
  await waitFor(() => expect(latestEditorProps()?.fileRefOptions?.length ?? 0).toBeGreaterThan(0))
}

describe('DaemonDocumentPage file refs', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetCapturedEditorProps()
    createdBackends.length = 0
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [
        { path: 'main', documentId: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' },
        { path: 'second', documentId: 'id-second', updatedAt: '2026-01-02', kind: 'spatial' },
      ],
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('passes an unknown ref through unchanged as a legacy path reference', async () => {
    await renderPage()
    await act(async () => {
      latestEditorProps()?.onOpenFileRef?.('second')
    })
    await waitFor(() =>
      expect(createdBackends.at(-1)).toMatchObject({ workspaceId: 'w1', path: 'second' }),
    )
  })
})
