/**
 * The document-page contract against the DAEMON keeper: the daemon's list
 * routes mocked, the sync backend faked and recorded, so "opened another
 * document" is a new backend built for that path.
 */
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { act, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import {
  type ContractDocument,
  type DocumentPageFixture,
  describeDocumentPageContract,
} from './document-page.contract.js'

vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  const { CapturingSpatialEditor } = await import('../test-utils/capturing-spatial-editor.js')
  return { ...actual, SpatialEditor: CapturingSpatialEditor }
})

vi.mock('../lib/replica-refresh.js', () => ({
  scheduleReplicaRefresh: vi.fn(),
  scheduleReplicaPush: vi.fn(),
}))

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return {
    ...actual,
    listWorkspaces: vi.fn(),
    listDocuments: vi.fn(),
    createDocument: vi.fn(),
    getDocumentBacklinks: vi.fn(),
  }
})

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)
const mockGetDocumentBacklinks = vi.mocked(daemonApiClient.getDocumentBacklinks)

// Every fake backend built, in order: the page opens a document by building
// a backend for its path, so the most recent one says what is open.
const createdBackends: FakeBackend[] = []

class FakeBackend implements DocumentBackend {
  constructor(
    public workspaceId: string,
    public path: string,
  ) {
    createdBackends.push(this)
  }
  connect(handlers: DocumentBackendHandlers): void {
    handlers.onConnected()
    const { LoroDoc } = require('loro-crdt') as typeof import('loro-crdt')
    handlers.onSnapshot(new LoroDoc().export({ mode: 'snapshot' }))
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

function MemoryRouterWrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/']}>{children}</MemoryRouter>
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
    mockListDocuments.mockResolvedValue({
      documents: documents.map((doc) => ({
        path: doc.path,
        id: doc.id,
        updatedAt: '2026-01-01',
        kind: doc.kind,
      })),
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
}

describeDocumentPageContract(daemonFixture)
