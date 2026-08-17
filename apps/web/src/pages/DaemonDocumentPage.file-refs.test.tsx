/**
 * File-reference identity on the daemon page: new file nodes reference the
 * target canvas's immutable id (rename-safe, ADR-0008), while everything
 * user-facing stays on paths. These tests pin the page-level wiring — the
 * options handed to the editor carry ids labeled with paths, and opening a
 * ref resolves the id back to the CURRENT path by lookup, with unknown refs
 * passing through as legacy path references.
 */
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpatialEditorProps } from '../components/spatial-editor/index.js'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { DaemonDocumentPage } from './DaemonDocumentPage.js'

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return {
    ...actual,
    listWorkspaces: vi.fn(),
    listDocuments: vi.fn(),
  }
})

// Captures the editor's file-ref props without mounting the real canvas —
// what this file tests is the page's wiring, not the editor's rendering.
let capturedEditorProps: SpatialEditorProps | null = null
vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  return {
    ...actual,
    SpatialEditor: (props: SpatialEditorProps) => {
      capturedEditorProps = props
      return <div data-testid="stub-spatial-editor" />
    },
  }
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
  await waitFor(() => expect(capturedEditorProps?.fileRefOptions?.length).toBeGreaterThan(0))
}

describe('DaemonDocumentPage file refs', () => {
  beforeEach(() => {
    window.localStorage.clear()
    capturedEditorProps = null
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

  it('offers other documents as id-valued refs labeled with their path', async () => {
    await renderPage()
    // The open canvas (main) is excluded; the ref stored into the document
    // is the id, the label the user sees is the path. `kind` rides along
    // because it decides the geometry of the node the picker creates — a
    // markdown reference renders prose and needs room a card does not.
    expect(capturedEditorProps?.fileRefOptions).toEqual([
      { file: 'id-second', label: 'second', kind: 'spatial' },
    ])
  })

  it('opens an id ref on the target canvas current path', async () => {
    await renderPage()
    await act(async () => {
      capturedEditorProps?.onOpenFileRef?.('id-second')
    })
    await waitFor(() =>
      expect(createdBackends.at(-1)).toMatchObject({ workspaceId: 'w1', path: 'second' }),
    )
  })

  it('passes an unknown ref through unchanged as a legacy path reference', async () => {
    await renderPage()
    await act(async () => {
      capturedEditorProps?.onOpenFileRef?.('second')
    })
    await waitFor(() =>
      expect(createdBackends.at(-1)).toMatchObject({ workspaceId: 'w1', path: 'second' }),
    )
  })

  it('marks refs matching neither a live id nor a live path as missing, sparing image refs', async () => {
    await renderPage()
    const missing = capturedEditorProps?.missingFileRef
    expect(missing).toBeDefined()
    // Live id and live path (a legacy ref) are both known; a ref matching
    // neither points at a deleted canvas. Image refs live in the file
    // store, not the documents list, so they are never "missing" here.
    expect(missing?.('id-second')).toBe(false)
    expect(missing?.('second')).toBe(false)
    expect(missing?.('deleted-canvas-id')).toBe(true)
    expect(missing?.('asset:0f5bffa1-9d0f-4d2f-a2c4-0f0d4a1a2b3c')).toBe(false)
  })

  it('falls back to path refs for entries an older daemon lists without ids', async () => {
    mockListDocuments.mockResolvedValue({
      documents: [
        { path: 'main', updatedAt: '2026-01-01', kind: 'spatial' },
        { path: 'second', updatedAt: '2026-01-02', kind: 'spatial' },
      ],
    })
    await renderPage()
    expect(capturedEditorProps?.fileRefOptions).toEqual([
      { file: 'second', label: 'second', kind: 'spatial' },
    ])
  })
})
