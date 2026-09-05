/**
 * The daemon keeper's own WebMCP case. The shared scenarios (every tool
 * registers once a document is on screen, none when the setting is off) run
 * against both keepers in `document-page.contract.tsx`; this one has no
 * browser twin, because the browser keeper always has a document to open
 * and the daemon can resolve a workspace to none.
 */
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { act, cleanup, type RenderOptions, render as rtlRender } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import type { ModelContext, WebMcpToolDescriptor } from '../lib/webmcp/use-browser-tool-registry.js'
import { DaemonDocumentPage } from './DaemonDocumentPage.js'

// The page reads useNavigate (Settings navigation), so every render needs a
// Router ancestor.
function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>, options)
}

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return {
    ...actual,
    listWorkspaces: vi.fn(),
    listDocuments: vi.fn(),
    createDocument: vi.fn(),
  }
})

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)

class FakeBackend implements DocumentBackend {
  handlers: DocumentBackendHandlers | null = null
  constructor(
    public workspaceId: string,
    public path: string,
  ) {}
  connect(handlers: DocumentBackendHandlers): void {
    this.handlers = handlers
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

function makeCreateBackend() {
  return (workspaceId: string, path: string) => new FakeBackend(workspaceId, path)
}

function createFakeModelContext(): ModelContext & { liveNames(): string[] } {
  const live = new Map<string, AbortSignal>()
  return {
    liveNames: () => [...live.keys()],
    registerTool: async (descriptor: WebMcpToolDescriptor, options: { signal: AbortSignal }) => {
      await Promise.resolve()
      if (options.signal.aborted) return
      live.set(descriptor.name, options.signal)
      options.signal.addEventListener('abort', () => live.delete(descriptor.name))
    },
  }
}

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

describe('DaemonDocumentPage WebMCP wiring', () => {
  beforeEach(() => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    localStorage.clear()
    delete (document as { modelContext?: unknown }).modelContext
  })

  it('attempts no registration while the workspace resolves to zero documents (canvas === null)', async () => {
    mockListDocuments.mockResolvedValue({ documents: [] })
    const fake = createFakeModelContext()
    document.modelContext = fake

    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fake.liveNames()).toEqual([])
  })
})
