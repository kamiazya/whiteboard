/**
 * The daemon keeper's own file-reference case. The shared scenarios (other
 * documents offered as id refs under their label, an id ref opening its
 * current path, the missing-ref rule) run against both keepers in
 * `document-page.contract.tsx`. What is left here is where the keepers
 * deliberately differ: a ref the daemon's list does not know as an id is
 * taken as a LEGACY PATH reference and opened as one — the browser page
 * instead leaves the address bar alone (its own file has that case).
 */
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import {
  latestEditorProps,
  resetCapturedEditorProps,
} from '../test-utils/capturing-spatial-editor.js'
import { DaemonDocumentPage } from './DaemonDocumentPage.js'

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return {
    ...actual,
    listWorkspaces: vi.fn(),
    listDocuments: vi.fn(),
  }
})

vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  const { CapturingSpatialEditor } = await import('../test-utils/capturing-spatial-editor.js')
  return { ...actual, SpatialEditor: CapturingSpatialEditor }
})

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)

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

const createdBackends: FakeBackend[] = []

function MemoryRouterWrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/']}>{children}</MemoryRouter>
}

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
        { path: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' },
        { path: 'second', id: 'id-second', updatedAt: '2026-01-02', kind: 'spatial' },
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
