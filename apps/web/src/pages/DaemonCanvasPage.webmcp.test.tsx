import type {
  CanvasBackend,
  CanvasBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import {
  act,
  cleanup,
  type RenderOptions,
  render as rtlRender,
  waitFor,
} from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { defaultUserSettings, STORAGE_KEY } from '../lib/user-settings-store.js'
import { webMcpTools } from '../lib/webmcp/tool-definitions.js'
import type { ModelContext, WebMcpToolDescriptor } from '../lib/webmcp/use-browser-tool-registry.js'
import { DaemonCanvasPage } from './DaemonCanvasPage.js'

// The page now reads useNavigate (Settings navigation), so every render
// needs a Router ancestor — wrapping once here keeps the existing
// `render(<DaemonCanvasPage .../>)` call sites throughout this file unchanged.
function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>, options)
}

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return {
    ...actual,
    listWorkspaces: vi.fn(),
    listCanvases: vi.fn(),
    createCanvas: vi.fn(),
  }
})

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListCanvases = vi.mocked(daemonApiClient.listCanvases)

class FakeBackend implements CanvasBackend {
  handlers: CanvasBackendHandlers | null = null
  constructor(
    public workspaceId: string,
    public slug: string,
  ) {}
  connect(handlers: CanvasBackendHandlers): void {
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
  return (workspaceId: string, slug: string) => new FakeBackend(workspaceId, slug)
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

describe('DaemonCanvasPage WebMCP wiring', () => {
  beforeEach(() => {
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListCanvases.mockResolvedValue({
      canvases: [{ slug: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' }],
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    localStorage.clear()
    delete (document as { modelContext?: unknown }).modelContext
  })

  it('registers every read-only tool, keyed on workspaceId/slug, once a daemon canvas loads', async () => {
    const fake = createFakeModelContext()
    document.modelContext = fake

    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await waitFor(() =>
      expect(document.querySelector('[data-testid="spatial-editor-container"]')).toBeTruthy(),
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fake.liveNames().sort()).toEqual(webMcpTools.map((tool) => tool.name).sort())
  })

  it('attempts no registration while the workspace resolves to zero canvases (canvas === null)', async () => {
    mockListCanvases.mockResolvedValue({ canvases: [] })
    const fake = createFakeModelContext()
    document.modelContext = fake

    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fake.liveNames()).toEqual([])
  })

  it('registers no tools when capabilities.webMcpEnabled is persisted as false', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...defaultUserSettings(),
        capabilities: { webMcpEnabled: false },
      }),
    )
    const fake = createFakeModelContext()
    document.modelContext = fake

    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await waitFor(() =>
      expect(document.querySelector('[data-testid="spatial-editor-container"]')).toBeTruthy(),
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fake.liveNames()).toEqual([])
  })
})
