import { act, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { FakeDocumentBackend, MemoryRouterWrapper } from '../test-utils/daemon-page-harness.js'
import {
  type ContractDocument,
  type DocumentPageFixture,
  describeDocumentPageContract,
} from '../test-utils/document-page.contract.js'

vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  const { CapturingSpatialEditor } = await import('../test-utils/capturing-spatial-editor.js')
  return { ...actual, SpatialEditor: CapturingSpatialEditor }
})

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
    'createDocument',
    'getDocumentBacklinks',
    'deleteDocument',
  ]),
)

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)
const mockGetDocumentBacklinks = vi.mocked(daemonApiClient.getDocumentBacklinks)
const mockDeleteDocument = vi.mocked(daemonApiClient.deleteDocument)

// Every fake backend built, in order: the page opens a document by building
// a backend for its path, so the most recent one says what is open.
const createdBackends: FakeBackend[] = []

class FakeBackend extends FakeDocumentBackend {
  constructor(
    public workspaceId: string,
    public path: string,
  ) {
    super()
    createdBackends.push(this)
  }
}

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

afterEach(() => {
  vi.clearAllMocks()
  createdBackends.length = 0
})

const daemonFixture: DocumentPageFixture = {
  keeper: 'daemon',
  async mount(documents: readonly ContractDocument[]) {
    const [open] = documents
    if (open === undefined) throw new Error('mount needs at least one document')
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    // A store, not a fixed answer: a delete removes its row, so the list the
    // page refreshes afterwards says what the daemon would.
    let listed = documents.map((doc) => ({
      path: doc.path,
      documentId: doc.id,
      updatedAt: '2026-01-01',
      kind: doc.kind,
    }))
    mockListDocuments.mockImplementation(async () => ({ documents: listed }))
    mockDeleteDocument.mockImplementation(async (_fetch, _base, _workspaceId, path) => {
      listed = listed.filter((doc) => doc.path !== path)
      return { ok: true as const }
    })
    mockGetDocumentBacklinks.mockResolvedValue({ backlinks: [], unlinkedMentions: [] })
    await act(async () => {
      rtlRender(
        <DaemonDocumentPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspaceId="w1"
          path={open.path}
          createBackend={(workspaceId, path) => new FakeBackend(workspaceId, path)}
        />,
        { wrapper: MemoryRouterWrapper, container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('stub-spatial-editor')).toBeTruthy())
  },
  // The daemon summary carries no display name, so the path stands in.
  labelOf: (doc) => doc.path,
  async expectOpened(path) {
    await waitFor(() => expect(createdBackends.at(-1)).toMatchObject({ workspaceId: 'w1', path }))
  },
  failNextDelete() {
    mockDeleteDocument.mockRejectedValueOnce(new Error('simulated daemon refusal'))
  },
}

describeDocumentPageContract(daemonFixture)
