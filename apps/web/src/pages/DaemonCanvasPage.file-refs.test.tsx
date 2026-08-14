/**
 * File-reference identity on the daemon page: new file nodes reference the
 * target canvas's immutable id (rename-safe, ADR-0008), while everything
 * user-facing stays on slugs. These tests pin the page-level wiring — the
 * options handed to the editor carry ids labeled with slugs, and opening a
 * ref resolves the id back to the CURRENT slug by lookup, with unknown refs
 * passing through as legacy slug references.
 */
import type {
  CanvasBackend,
  CanvasBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpatialEditorProps } from '../components/spatial-editor/index.js'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { DaemonCanvasPage } from './DaemonCanvasPage.js'

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return {
    ...actual,
    listWorkspaces: vi.fn(),
    listCanvases: vi.fn(),
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
const mockListCanvases = vi.mocked(daemonApiClient.listCanvases)

class FakeBackend implements CanvasBackend {
  constructor(
    public workspaceId: string,
    public slug: string,
  ) {
    createdBackends.push(this)
  }
  connect(handlers: CanvasBackendHandlers): void {
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
      <DaemonCanvasPage
        daemonBaseUrl={DAEMON_BASE_URL}
        createBackend={(workspaceId, slug) => new FakeBackend(workspaceId, slug)}
      />,
      { wrapper: MemoryRouterWrapper, container: document.body },
    )
  })
  await waitFor(() => expect(screen.getByTestId('stub-spatial-editor')).toBeTruthy())
  await waitFor(() => expect(capturedEditorProps?.fileRefOptions?.length).toBeGreaterThan(0))
}

describe('DaemonCanvasPage file refs', () => {
  beforeEach(() => {
    window.localStorage.clear()
    capturedEditorProps = null
    createdBackends.length = 0
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListCanvases.mockResolvedValue({
      canvases: [
        { slug: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' },
        { slug: 'second', id: 'id-second', updatedAt: '2026-01-02', kind: 'spatial' },
      ],
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('offers other canvases as id-valued refs labeled with their slug', async () => {
    await renderPage()
    // The open canvas (main) is excluded; the ref stored into the document
    // is the id, the label the user sees is the slug.
    expect(capturedEditorProps?.fileRefOptions).toEqual([{ file: 'id-second', label: 'second' }])
  })

  it('opens an id ref on the target canvas current slug', async () => {
    await renderPage()
    await act(async () => {
      capturedEditorProps?.onOpenFileRef?.('id-second')
    })
    await waitFor(() =>
      expect(createdBackends.at(-1)).toMatchObject({ workspaceId: 'w1', slug: 'second' }),
    )
  })

  it('passes an unknown ref through unchanged as a legacy slug reference', async () => {
    await renderPage()
    await act(async () => {
      capturedEditorProps?.onOpenFileRef?.('second')
    })
    await waitFor(() =>
      expect(createdBackends.at(-1)).toMatchObject({ workspaceId: 'w1', slug: 'second' }),
    )
  })

  it('falls back to slug refs for entries an older daemon lists without ids', async () => {
    mockListCanvases.mockResolvedValue({
      canvases: [
        { slug: 'main', updatedAt: '2026-01-01', kind: 'spatial' },
        { slug: 'second', updatedAt: '2026-01-02', kind: 'spatial' },
      ],
    })
    await renderPage()
    expect(capturedEditorProps?.fileRefOptions).toEqual([{ file: 'second', label: 'second' }])
  })
})
