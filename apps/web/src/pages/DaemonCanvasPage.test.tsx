import type {
  CanvasBackend,
  CanvasBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { DaemonCanvasPage } from './DaemonCanvasPage.js'

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: ({ excalidrawAPI }: { excalidrawAPI?: (api: unknown) => void }) => {
    if (excalidrawAPI) {
      excalidrawAPI({
        updateScene: vi.fn(),
        addFiles: vi.fn(),
        getSceneElements: () => [],
        getAppState: () => ({}),
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
const mockCreateCanvas = vi.mocked(daemonApiClient.createCanvas)

// Records every fake backend instance created, in order, so tests can assert
// exactly-once disconnect and ordering (old disconnects before new connects).
const createdBackends: FakeBackend[] = []

class FakeBackend implements CanvasBackend {
  handlers: CanvasBackendHandlers | null = null
  connectCount = 0
  disconnectCount = 0
  constructor(
    public workspaceId: string,
    public slug: string,
  ) {
    createdBackends.push(this)
  }
  connect(handlers: CanvasBackendHandlers): void {
    this.connectCount += 1
    this.handlers = handlers
    handlers.onConnected()
    const { LoroDoc } = require('loro-crdt') as typeof import('loro-crdt')
    handlers.onSnapshot(new LoroDoc().export({ mode: 'snapshot' }))
  }
  disconnect(): void {
    this.disconnectCount += 1
  }
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

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

describe('DaemonCanvasPage', () => {
  beforeEach(() => {
    createdBackends.length = 0
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListCanvases.mockResolvedValue({
      canvases: [
        { slug: 'main', updatedAt: '2026-01-01' },
        { slug: 'second', updatedAt: '2026-01-02' },
      ],
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('mounts the editor with a mocked backend and renders the canvas list', async () => {
    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
      )
    })

    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())
    const select = screen.getByLabelText('Canvases') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['main', 'second'])
    expect(createdBackends).toHaveLength(1)
    expect(createdBackends[0]?.connectCount).toBe(1)
  })

  it('renders capability badges from LOCAL_DAEMON_CAPABILITIES', async () => {
    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
      )
    })
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())
    expect(screen.getByText('Version history')).toBeTruthy()
    expect(screen.getByText('Workspaces')).toBeTruthy()
  })

  it('disconnects the old backend before the new one is observed on canvas switch', async () => {
    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
      )
    })
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

    const select = screen.getByLabelText('Canvases') as HTMLSelectElement
    const oldBackend = createdBackends[0]!

    await act(async () => {
      select.value = 'second'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(oldBackend.disconnectCount).toBe(1)
    expect(createdBackends).toHaveLength(2)
    expect(createdBackends[1]?.connectCount).toBe(1)
    expect(createdBackends[1]?.disconnectCount).toBe(0)
  })

  it('shows a role=alert banner on WS auth failure (close 1008 -> onAuthError)', async () => {
    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
      )
    })
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

    const backend = createdBackends[0]!
    await act(async () => {
      backend.handlers?.onAuthError?.()
    })

    expect(screen.getByRole('alert').textContent).toMatch(/daemon rejected/i)
    // Editor chrome stays mounted — auth error is a banner, not a full-page replacement.
    expect(screen.getByTestId('excalidraw-container')).toBeTruthy()
  })

  it('shows the connecting status while workspace/canvas resolution is pending', async () => {
    // Never resolves during this test, so the page stays in the loading state.
    mockListWorkspaces.mockReturnValue(new Promise(() => {}))

    render(<DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />)

    expect(screen.getByRole('status').textContent).toMatch(/connecting to daemon/i)
  })

  it('shows a full-page alert when workspace/canvas resolution fails', async () => {
    mockListWorkspaces.mockRejectedValue(new Error('daemon unreachable'))

    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
      )
    })

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toMatch(/daemon unreachable/i)
    expect(screen.queryByTestId('excalidraw-container')).toBeNull()
  })

  it('renders a create-canvas form when the workspace has zero canvases', async () => {
    mockListCanvases.mockResolvedValue({ canvases: [] })

    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
      )
    })

    await waitFor(() =>
      expect(screen.getByText('This workspace has no canvases yet.')).toBeTruthy(),
    )
    expect(screen.queryByLabelText('Canvases')).toBeNull()
    expect(screen.queryByTestId('excalidraw-container')).toBeNull()
    expect(screen.getByLabelText('New canvas name')).toBeTruthy()
  })

  it('submits the create-canvas form and mounts the editor once the canvas exists', async () => {
    mockListCanvases.mockResolvedValueOnce({ canvases: [] })
    mockCreateCanvas.mockResolvedValue({ slug: 'brand-new' })
    mockListCanvases.mockResolvedValueOnce({
      canvases: [{ slug: 'brand-new', updatedAt: '2026-01-03' }],
    })

    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
      )
    })

    await waitFor(() =>
      expect(screen.getByText('This workspace has no canvases yet.')).toBeTruthy(),
    )

    const input = screen.getByLabelText('New canvas name') as HTMLInputElement
    const form = input.closest('form')!

    await act(async () => {
      fireEvent.change(input, { target: { value: 'brand-new' } })
    })
    await act(async () => {
      fireEvent.submit(form)
    })

    expect(mockCreateCanvas).toHaveBeenCalledWith(
      expect.anything(),
      DAEMON_BASE_URL,
      'w1',
      'brand-new',
    )
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())
  })

  it('shows the createError alert in the empty-canvases state when creation fails', async () => {
    mockListCanvases.mockResolvedValue({ canvases: [] })
    mockCreateCanvas.mockRejectedValue(new Error('slug already exists'))

    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
      )
    })

    await waitFor(() =>
      expect(screen.getByText('This workspace has no canvases yet.')).toBeTruthy(),
    )

    const input = screen.getByLabelText('New canvas name') as HTMLInputElement
    const form = input.closest('form')!

    await act(async () => {
      fireEvent.change(input, { target: { value: 'brand-new' } })
    })
    await act(async () => {
      fireEvent.submit(form)
    })

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toMatch(/slug already exists/i)
  })
})
