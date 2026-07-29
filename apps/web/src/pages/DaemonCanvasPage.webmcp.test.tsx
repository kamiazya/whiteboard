import type {
  CanvasBackend,
  CanvasBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { defaultUserSettings, STORAGE_KEY } from '../lib/user-settings-store.js'
import type { ModelContext, WebMcpToolDescriptor } from '../lib/webmcp/use-browser-tool-registry.js'
import { DaemonCanvasPage } from './DaemonCanvasPage.js'

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: ({ excalidrawAPI }: { excalidrawAPI?: (api: unknown) => void }) => {
    if (excalidrawAPI) {
      excalidrawAPI({
        updateScene: vi.fn(),
        addFiles: vi.fn(),
        getSceneElements: () => [],
        getAppState: () => ({}),
        getFiles: () => ({}),
      })
    }
    return <div data-testid="excalidraw-container" />
  },
  restoreElements: (els: unknown[]) => els,
  CaptureUpdateAction: { NEVER: 'NEVER' },
  exportToBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}))

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
      canvases: [{ slug: 'main', updatedAt: '2026-01-01' }],
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    localStorage.clear()
    delete (document as { modelContext?: unknown }).modelContext
  })

  it('registers both read-only tools, keyed on workspaceId/slug, once a daemon canvas loads', async () => {
    const fake = createFakeModelContext()
    document.modelContext = fake

    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await waitFor(() =>
      expect(document.querySelector('[data-testid="excalidraw-container"]')).toBeTruthy(),
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fake.liveNames().sort()).toEqual([
      'whiteboard_get_app_context',
      'whiteboard_get_scene_summary',
    ])
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
      expect(document.querySelector('[data-testid="excalidraw-container"]')).toBeTruthy(),
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fake.liveNames()).toEqual([])
  })
})
