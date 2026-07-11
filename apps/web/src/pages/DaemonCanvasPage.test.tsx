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

// WorkspaceTopBar's canvas switcher dropdown is real Radix — open on
// pointerDown, select on pointerUp (see WorkspaceTopBar.test.tsx for the
// same pattern). Rendering into document.body (per every render() call in
// this file) keeps the portal content inside React's event-delegation root.
// Exact match: HeaderBranchChip's "Switch branch (current: <name>)" button
// also contains the canvas slug as a substring, so a loose regex match is
// ambiguous now that WorkspaceTopBar renders both in the same header.
async function openCanvasSwitcher(currentLabel: string) {
  const switcher = screen.getByRole('button', {
    name: new RegExp(`^${currentLabel}$`),
  })
  fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
  await screen.findByTestId('new-canvas-menu-item')
}

async function selectCanvasFromSwitcher(label: string) {
  const item = (await screen.findByText(label)).closest('[role="menuitem"]') as HTMLElement
  fireEvent.pointerUp(item)
}

// The bar's History button opens the version popover, which now also
// carries the page's own "Save version" button/message via versionPanelExtra.
function toggleHistoryPanel() {
  fireEvent.click(screen.getByRole('button', { name: /history/i }))
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
        { container: document.body },
      )
    })

    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())
    // WorkspaceTopBar's canvas switcher shows the current canvas and lists
    // every entry from controller.canvases — this pins the CanvasSummary
    // {slug, updatedAt} -> WorkspaceTopBar CanvasInfo mapping end to end.
    expect(screen.getByRole('button', { name: /^main$/ })).toBeTruthy()
    await openCanvasSwitcher('main')
    expect(screen.getByText('second')).toBeTruthy()
    expect(createdBackends).toHaveLength(1)
    expect(createdBackends[0]?.connectCount).toBe(1)
  })

  it('renders capability badges from LOCAL_DAEMON_CAPABILITIES', async () => {
    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())
    // The bar's History button is the real versions-capability affordance
    // now that WorkspaceTopBar owns it (see WorkspaceTopBar.tsx).
    expect(screen.getByRole('button', { name: /history/i })).toBeTruthy()
    // Workspaces is now a real switcher (not a static teaser) once
    // capabilities.workspaces is true and the daemon has workspaces to list.
    expect(screen.getByLabelText('Workspaces')).toBeTruthy()
  })

  describe('workspace switcher', () => {
    it('lists workspaces from GET /api/workspaces even though the page supplies an initial workspaceId', async () => {
      mockListWorkspaces.mockResolvedValue({
        workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
      })

      await act(async () => {
        render(
          <DaemonCanvasPage
            daemonBaseUrl={DAEMON_BASE_URL}
            workspaceId="w1"
            slug="main"
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      const workspaceSelect = screen.getByLabelText('Workspaces') as HTMLSelectElement
      expect(Array.from(workspaceSelect.options).map((o) => o.value)).toEqual(['w1', 'w2'])
    })

    it('selecting another workspace re-resolves the canvas and re-keys the backend', async () => {
      mockListWorkspaces.mockResolvedValue({
        workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
      })
      mockListCanvases.mockImplementation((_fetch, _base, workspaceId) => {
        if (workspaceId === 'w2') {
          return Promise.resolve({ canvases: [{ slug: 'w2-main', updatedAt: '2026-02-01' }] })
        }
        return Promise.resolve({
          canvases: [
            { slug: 'main', updatedAt: '2026-01-01' },
            { slug: 'second', updatedAt: '2026-01-02' },
          ],
        })
      })

      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())
      expect(createdBackends).toHaveLength(1)
      expect(createdBackends[0]?.workspaceId).toBe('w1')

      const workspaceSelect = screen.getByLabelText('Workspaces') as HTMLSelectElement
      await act(async () => {
        workspaceSelect.value = 'w2'
        workspaceSelect.dispatchEvent(new Event('change', { bubbles: true }))
      })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /w2-main/i })).toBeTruthy()
      })
      expect(createdBackends).toHaveLength(2)
      expect(createdBackends[1]?.workspaceId).toBe('w2')
      expect(createdBackends[0]?.disconnectCount).toBe(1)
    })

    it('shows the empty-state create form when the switched-to workspace has zero canvases', async () => {
      mockListWorkspaces.mockResolvedValue({
        workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
      })
      mockListCanvases.mockImplementation((_fetch, _base, workspaceId) => {
        if (workspaceId === 'w2') return Promise.resolve({ canvases: [] })
        return Promise.resolve({
          canvases: [
            { slug: 'main', updatedAt: '2026-01-01' },
            { slug: 'second', updatedAt: '2026-01-02' },
          ],
        })
      })

      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      const workspaceSelect = screen.getByLabelText('Workspaces') as HTMLSelectElement
      await act(async () => {
        workspaceSelect.value = 'w2'
        workspaceSelect.dispatchEvent(new Event('change', { bubbles: true }))
      })

      await waitFor(() =>
        expect(screen.getByText('This workspace has no canvases yet.')).toBeTruthy(),
      )
    })

    it('keeps the editor mounted and shows an inline error when switching workspace fails', async () => {
      mockListWorkspaces.mockResolvedValue({
        workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
      })
      mockListCanvases.mockResolvedValueOnce({
        canvases: [
          { slug: 'main', updatedAt: '2026-01-01' },
          { slug: 'second', updatedAt: '2026-01-02' },
        ],
      })

      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())
      expect(createdBackends).toHaveLength(1)

      mockListCanvases.mockRejectedValueOnce(new Error('daemon unreachable'))

      const workspaceSelect = screen.getByLabelText('Workspaces') as HTMLSelectElement
      await act(async () => {
        workspaceSelect.value = 'w2'
        workspaceSelect.dispatchEvent(new Event('change', { bubbles: true }))
      })

      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toMatch(/daemon unreachable/i),
      )
      // A transient switch failure must not tear down the still-valid editor session.
      expect(screen.getByTestId('excalidraw-container')).toBeTruthy()
      expect(createdBackends).toHaveLength(1)
      expect(createdBackends[0]?.disconnectCount).toBe(0)
    })

    it('shows the static disabled teaser instead of the switcher when capabilities.workspaces is false', async () => {
      await act(async () => {
        render(
          <DaemonCanvasPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
            capabilities={{
              canvasReadWrite: true,
              migrationExport: false,
              migrationImport: true,
              workspaces: false,
              versions: true,
              branches: true,
              merge: true,
            }}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      expect(screen.queryByLabelText('Workspaces')).toBeNull()
      const teaser = screen.getByText('Workspaces')
      expect(teaser.getAttribute('aria-disabled')).toBe('true')
    })
  })

  it('disconnects the old backend before the new one is observed on canvas switch', async () => {
    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

    const oldBackend = createdBackends[0]!

    await act(async () => {
      await openCanvasSwitcher('main')
      await selectCanvasFromSwitcher('second')
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
        { container: document.body },
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

  it('clears the auth-error banner when switching to a new canvas (new backend identity)', async () => {
    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

    await act(async () => {
      createdBackends[0]?.handlers?.onAuthError?.()
    })
    expect(screen.getByRole('alert').textContent).toMatch(/daemon rejected/i)

    await act(async () => {
      await openCanvasSwitcher('main')
      await selectCanvasFromSwitcher('second')
    })

    // The stale banner must not outlive the backend that produced it.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders a browser-local escape button in the auth banner and invokes the callback', async () => {
    const onContinueBrowserLocal = vi.fn()
    await act(async () => {
      render(
        <DaemonCanvasPage
          daemonBaseUrl={DAEMON_BASE_URL}
          createBackend={makeCreateBackend()}
          onContinueBrowserLocal={onContinueBrowserLocal}
        />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

    await act(async () => {
      createdBackends[0]?.handlers?.onAuthError?.()
    })

    const escape = screen.getByRole('button', { name: /continue in browser-local/i })
    await act(async () => {
      escape.click()
    })
    expect(onContinueBrowserLocal).toHaveBeenCalledTimes(1)
  })

  it('shows the connecting status while workspace/canvas resolution is pending', async () => {
    // Never resolves during this test, so the page stays in the loading state.
    mockListWorkspaces.mockReturnValue(new Promise(() => {}))

    render(
      <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
      { container: document.body },
    )

    expect(screen.getByRole('status').textContent).toMatch(/connecting to daemon/i)
  })

  it('shows a full-page alert when workspace/canvas resolution fails', async () => {
    mockListWorkspaces.mockRejectedValue(new Error('daemon unreachable'))

    await act(async () => {
      render(
        <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
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
        { container: document.body },
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
        { container: document.body },
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
        { container: document.body },
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

  describe('manual save version', () => {
    it('POSTs a version via the daemon fetch and shows an inline success message', async () => {
      const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        (input, init) => {
          const url = String(input)
          if (url.includes('/branches')) {
            return Promise.resolve(
              new Response(JSON.stringify({ head: 'main', branches: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
          }
          if (url.includes('/workspaces/w1/canvases/main/versions') && init?.method === 'POST') {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  version: {
                    id: 'v-manual',
                    slug: 'main',
                    createdAt: '2026-01-01T00:00:00Z',
                    elementCount: 3,
                    auto: false,
                    hasThumbnail: false,
                    branchName: 'main',
                  },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
              ),
            )
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      )
      vi.stubGlobal('fetch', fetchMock)

      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      toggleHistoryPanel()
      const saveButton = await screen.findByRole('button', { name: 'Save version' })
      await act(async () => {
        saveButton.click()
      })

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(
            ([reqInput, init]) =>
              String(reqInput).startsWith(DAEMON_BASE_URL) &&
              String(reqInput).includes('/workspaces/w1/canvases/main/versions') &&
              init?.method === 'POST',
          ),
        ).toBe(true)
      })
      await waitFor(() => expect(screen.getByText(/saved/i)).toBeTruthy())

      vi.unstubAllGlobals()
    })

    it('shows an inline error when the save response does not match saveVersionResponseSchema', async () => {
      const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        (input, init) => {
          const url = String(input)
          if (url.includes('/branches')) {
            return Promise.resolve(
              new Response(JSON.stringify({ head: 'main', branches: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
          }
          if (url.includes('/workspaces/w1/canvases/main/versions') && init?.method === 'POST') {
            // Malformed 200: missing the `version` envelope the schema requires.
            return Promise.resolve(
              new Response(JSON.stringify({ id: 'v-manual' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      )
      vi.stubGlobal('fetch', fetchMock)

      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      toggleHistoryPanel()
      const saveButton = await screen.findByRole('button', { name: 'Save version' })
      await act(async () => {
        saveButton.click()
      })

      await waitFor(() => expect(screen.getByText(/save failed/i)).toBeTruthy())

      vi.unstubAllGlobals()
    })

    it('does not render the save button when capabilities.versions is false', async () => {
      await act(async () => {
        render(
          <DaemonCanvasPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
            capabilities={{
              canvasReadWrite: true,
              migrationExport: false,
              migrationImport: true,
              workspaces: true,
              versions: false,
              branches: true,
              merge: true,
            }}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      expect(screen.queryByRole('button', { name: 'Save version' })).toBeNull()
    })

    it('shows an inline error when the save request fails', async () => {
      const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        (input, init) => {
          const url = String(input)
          if (url.includes('/branches')) {
            return Promise.resolve(
              new Response(JSON.stringify({ head: 'main', branches: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
          }
          if (url.includes('/workspaces/w1/canvases/main/versions') && init?.method === 'POST') {
            return Promise.resolve(new Response('nope', { status: 500 }))
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      )
      vi.stubGlobal('fetch', fetchMock)

      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      toggleHistoryPanel()
      const saveButton = await screen.findByRole('button', { name: 'Save version' })
      await act(async () => {
        saveButton.click()
      })

      await waitFor(() => expect(screen.getByText(/save failed/i)).toBeTruthy())

      vi.unstubAllGlobals()
    })

    it('disables the save button while a save is in flight and when no canvas is selected', async () => {
      mockListCanvases.mockResolvedValue({ canvases: [] })

      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })

      await waitFor(() =>
        expect(screen.getByText('This workspace has no canvases yet.')).toBeTruthy(),
      )
      expect(screen.queryByRole('button', { name: 'Save version' })).toBeNull()
    })
  })

  describe('version history panel', () => {
    it('opens the panel and lists versions for the current (workspaceId, slug) via the daemon fetch', async () => {
      const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        (input) => {
          const url = String(input)
          if (url.includes('/branches')) {
            return Promise.resolve(
              new Response(JSON.stringify({ head: 'main', branches: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
          }
          if (url.includes('/versions')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  versions: [
                    {
                      id: 'v-1',
                      slug: 'main',
                      createdAt: '2026-01-01T00:00:00Z',
                      elementCount: 3,
                      auto: true,
                      hasThumbnail: false,
                      branchName: 'main',
                    },
                  ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
              ),
            )
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      )
      vi.stubGlobal('fetch', fetchMock)

      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      const toggle = screen.getByRole('button', { name: 'History' })
      await act(async () => {
        toggle.click()
      })

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(
            ([reqInput]) =>
              String(reqInput).startsWith(DAEMON_BASE_URL) &&
              String(reqInput).includes('/workspaces/w1/canvases/main/versions'),
          ),
        ).toBe(true)
      })
      await waitFor(() => expect(screen.getByText('3 els', { exact: false })).toBeTruthy())

      vi.unstubAllGlobals()
    })

    it('closes the panel when the History toggle is clicked again', async () => {
      const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        (input) => {
          const url = String(input)
          if (url.includes('/branches')) {
            return Promise.resolve(
              new Response(JSON.stringify({ head: 'main', branches: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
          }
          if (url.includes('/versions')) {
            return Promise.resolve(
              new Response(JSON.stringify({ versions: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      )
      vi.stubGlobal('fetch', fetchMock)

      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      const toggle = screen.getByRole('button', { name: 'History' })
      await act(async () => {
        toggle.click()
      })
      await screen.findByText(/no versions on/i)

      await act(async () => {
        toggle.click()
      })

      expect(screen.queryByText(/no versions on/i)).toBeNull()

      vi.unstubAllGlobals()
    })

    it('shows the static disabled teaser instead of the toggle when capabilities.versions is false', async () => {
      await act(async () => {
        render(
          <DaemonCanvasPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
            capabilities={{
              canvasReadWrite: true,
              migrationExport: false,
              migrationImport: true,
              workspaces: true,
              versions: false,
              branches: true,
              merge: true,
            }}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      const versionButton = screen.getByRole('button', { name: 'Version history' })
      // The static CapabilityTeaser renders aria-disabled; the real toggle
      // never does, so this distinguishes the two without a false negative.
      expect(versionButton.getAttribute('aria-disabled')).toBe('true')
      expect(versionButton.hasAttribute('aria-pressed')).toBe(false)
    })

    it('restoring a version reflects on the canvas via the broadcast incremental update', async () => {
      const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        (input) => {
          const url = String(input)
          if (url.includes('/restore')) {
            return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
          }
          if (url.includes('/branches')) {
            return Promise.resolve(
              new Response(JSON.stringify({ head: 'main', branches: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
          }
          if (url.includes('/versions')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  versions: [
                    {
                      id: 'v-1',
                      slug: 'main',
                      createdAt: '2026-01-01T00:00:00Z',
                      elementCount: 3,
                      auto: true,
                      hasThumbnail: false,
                      branchName: 'main',
                    },
                  ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
              ),
            )
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      )
      vi.stubGlobal('fetch', fetchMock)

      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      const toggle = screen.getByRole('button', { name: 'History' })
      await act(async () => {
        toggle.click()
      })

      const row = await screen.findByText('⚙ System')
      await act(async () => {
        fireEvent.click(row.closest('button')!)
      })
      await waitFor(() => {
        expect(screen.getByText('Restore this version?')).toBeTruthy()
      })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
      })
      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(([reqInput]) =>
            String(reqInput).includes('/versions/v-1/restore'),
          ),
        ).toBe(true)
      })

      // Real transport: the initial load already delivered a snapshot via
      // onSnapshot (see FakeBackend.connect above); restore broadcasts a
      // second, incremental update via onRemoteUpdate — not another snapshot.
      const backend = createdBackends[0]!
      const { LoroDoc } = require('loro-crdt') as typeof import('loro-crdt')
      const restoredDoc = new LoroDoc()
      const list = restoredDoc.getMovableList('elements')
      const map = list.insertContainer(
        0,
        new (require('loro-crdt') as typeof import('loro-crdt')).LoroMap(),
      )
      map.set('id', 'restored-el')
      map.set('type', 'rectangle')
      map.set('x', 0)
      map.set('y', 0)
      map.set('width', 10)
      map.set('height', 10)
      map.set('isDeleted', false)
      restoredDoc.commit()
      const update = restoredDoc.export({ mode: 'update' })

      await act(async () => {
        backend.handlers?.onRemoteUpdate?.(update)
      })

      await waitFor(() => expect(screen.queryByText('Restore this version?')).toBeNull())

      vi.unstubAllGlobals()
    })
  })

  describe('branch UI', () => {
    function branchesFetchMock(
      branches: Array<{ name: string; color: string }> = [{ name: 'main', color: '#1971c2' }],
      head = 'main',
    ) {
      return vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((input) => {
        const url = String(input)
        if (url.includes('/branches')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                head,
                branches: branches.map((b) => ({
                  name: b.name,
                  color: b.color,
                  tipFrontiers: '',
                  createdAt: '2026-01-01T00:00:00Z',
                })),
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      })
    }

    it('renders HeaderBranchChip when capabilities.branches is true, using the daemon-origin fetch (not global apiFetch)', async () => {
      const fetchMock = branchesFetchMock()
      vi.stubGlobal('fetch', fetchMock)

      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      await waitFor(() => expect(screen.getByTestId('header-branch-chip')).toBeTruthy())
      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(
            ([reqInput]) =>
              String(reqInput).startsWith(DAEMON_BASE_URL) &&
              String(reqInput).includes('/workspaces/w1/canvases/main/branches'),
          ),
        ).toBe(true)
      })
      expect(screen.queryByText('Branches')).toBeNull()

      vi.unstubAllGlobals()
    })

    it('shows the static disabled teasers when capabilities.branches/merge are false', async () => {
      await act(async () => {
        render(
          <DaemonCanvasPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
            capabilities={{
              canvasReadWrite: true,
              migrationExport: false,
              migrationImport: true,
              workspaces: true,
              versions: true,
              branches: false,
              merge: false,
            }}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      expect(screen.queryByTestId('header-branch-chip')).toBeNull()
      expect(screen.getByText('Branches')).toBeTruthy()
      expect(screen.getByText('Merge')).toBeTruthy()
    })

    it('refetches the branch list when the backend reports an externally observed HEAD change', async () => {
      const fetchMock = branchesFetchMock([
        { name: 'main', color: '#1971c2' },
        { name: 'feature-x', color: '#9333ea' },
      ])
      vi.stubGlobal('fetch', fetchMock)

      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())
      await waitFor(() => expect(screen.getByTestId('header-branch-chip')).toBeTruthy())

      const branchCallCountBefore = fetchMock.mock.calls.filter(([reqInput]) =>
        String(reqInput).includes('/branches'),
      ).length

      const backend = createdBackends[0]!
      await act(async () => {
        backend.handlers?.onHeadChanged?.({ head: 'feature-x' })
      })

      await waitFor(() => {
        const branchCallCountAfter = fetchMock.mock.calls.filter(([reqInput]) =>
          String(reqInput).includes('/branches'),
        ).length
        expect(branchCallCountAfter).toBeGreaterThan(branchCallCountBefore)
      })

      vi.unstubAllGlobals()
    })
  })

  describe('MergeToast integration', () => {
    const dispatchMergeCommitted = (overrides: Partial<Record<string, unknown>> = {}) => {
      window.dispatchEvent(
        new CustomEvent('excalidraw:merge_committed', {
          detail: {
            workspaceId: 'w1',
            slug: 'main',
            sourceName: 'feature-x',
            targetName: 'main',
            newCount: 1,
            changedCount: 0,
            conflictCount: 0,
            newElementIds: [],
            conflictElementIds: [],
            ...overrides,
          },
        }),
      )
    }

    it('renders MergeToast and shows it once a merge_committed event fires when capabilities.merge is true', async () => {
      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      expect(screen.queryByTestId('merge-toast')).toBeNull()

      await act(async () => {
        dispatchMergeCommitted()
      })

      await waitFor(() => expect(screen.getByTestId('merge-toast')).toBeTruthy())
      expect(screen.getByTestId('merge-toast').textContent).toContain('feature-x')
    })

    it('does not mount MergeToast when capabilities.merge is false', async () => {
      await act(async () => {
        render(
          <DaemonCanvasPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
            capabilities={{
              canvasReadWrite: true,
              migrationExport: false,
              migrationImport: true,
              workspaces: true,
              versions: true,
              branches: true,
              merge: false,
            }}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      await act(async () => {
        dispatchMergeCommitted()
      })

      // MergeToast's own listener is never mounted, so the event is a no-op here.
      expect(screen.queryByTestId('merge-toast')).toBeNull()
    })

    it('wires MergeToast onRestored to clearLocalUndo (restore fetch clears the toast via the shared daemon fetch)', async () => {
      const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        (input) => {
          const url = String(input)
          if (url.includes('/restore')) {
            return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      )
      vi.stubGlobal('fetch', fetchMock)

      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      await act(async () => {
        dispatchMergeCommitted({ preMergeVersionId: 'v-pre' })
      })
      await waitFor(() => expect(screen.getByTestId('merge-toast')).toBeTruthy())

      await act(async () => {
        screen.getByTestId('merge-toast-undo').click()
      })

      // A successful undo calls onRestored (clearLocalUndo) and dismisses the toast;
      // this proves the prop is actually wired, not just present as a no-op default.
      await waitFor(() => expect(screen.queryByTestId('merge-toast')).toBeNull())
      expect(fetchMock.mock.calls.some(([reqInput]) => String(reqInput).includes('/restore'))).toBe(
        true,
      )

      vi.unstubAllGlobals()
    })
  })

  describe('WorkspaceTopBar chrome adoption', () => {
    it('does not render a "Back to canvas list" button (onNavigateBack omitted)', async () => {
      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      expect(screen.queryByRole('button', { name: 'Back to canvas list' })).toBeNull()
    })

    it('performs exactly one POST /versions on a single Cmd/Ctrl+S keydown', async () => {
      const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        (input, init) => {
          const url = String(input)
          if (url.includes('/branches')) {
            return Promise.resolve(
              new Response(JSON.stringify({ head: 'main', branches: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
          }
          if (url.includes('/workspaces/w1/canvases/main/versions') && init?.method === 'POST') {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  version: {
                    id: 'v-cmd-s',
                    slug: 'main',
                    createdAt: '2026-01-01T00:00:00Z',
                    elementCount: 0,
                    auto: false,
                    hasThumbnail: false,
                    branchName: 'main',
                  },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
              ),
            )
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      )
      vi.stubGlobal('fetch', fetchMock)

      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      await act(async () => {
        fireEvent.keyDown(window, { key: 's', metaKey: true })
      })

      await waitFor(() => {
        const postCalls = fetchMock.mock.calls.filter(
          ([reqInput, init]) =>
            String(reqInput).includes('/workspaces/w1/canvases/main/versions') &&
            init?.method === 'POST',
        )
        expect(postCalls).toHaveLength(1)
      })

      vi.unstubAllGlobals()
    })

    it('drives HeaderSaveDot dirty/clean via the identity-scoped doc_changed/version_saved events', async () => {
      const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        (input) => {
          const url = String(input)
          if (url.includes('/branches')) {
            return Promise.resolve(
              new Response(JSON.stringify({ head: 'main', branches: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      )
      vi.stubGlobal('fetch', fetchMock)

      await act(async () => {
        render(
          <DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeTruthy())

      expect(screen.queryByTestId('header-save-dot')).toBeNull()

      const backend = createdBackends[0]!
      const { LoroDoc, LoroMap } = require('loro-crdt') as typeof import('loro-crdt')
      const remoteDoc = new LoroDoc()
      const list = remoteDoc.getMovableList('elements')
      const map = list.insertContainer(0, new LoroMap())
      map.set('id', 'el-1')
      map.set('type', 'rectangle')
      map.set('x', 0)
      map.set('y', 0)
      map.set('width', 10)
      map.set('height', 10)
      map.set('isDeleted', false)
      remoteDoc.commit()
      const update = remoteDoc.export({ mode: 'update' })

      await act(async () => {
        backend.handlers?.onRemoteUpdate?.(update)
      })

      await waitFor(() => expect(screen.getByTestId('header-save-dot')).toBeTruthy())

      await act(async () => {
        backend.handlers?.onVersionCreated?.({
          id: 'v-remote',
          slug: 'main',
          createdAt: '2026-01-01T00:00:00Z',
          elementCount: 1,
          auto: false,
          hasThumbnail: false,
        })
      })

      await waitFor(() => expect(screen.queryByTestId('header-save-dot')).toBeNull())

      vi.unstubAllGlobals()
    })
  })

  describe('default backend wiring (no createBackend override)', () => {
    class FakeWebSocket {
      static instances: FakeWebSocket[] = []
      binaryType = 'blob'
      readyState = 0
      onopen: (() => void) | null = null
      onclose: ((event: { code: number }) => void) | null = null
      onerror: (() => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      send = vi.fn()
      close = vi.fn()

      constructor(
        public url: string,
        public protocols?: string | string[],
      ) {
        FakeWebSocket.instances.push(this)
      }
    }

    let originalWebSocket: typeof globalThis.WebSocket

    beforeEach(() => {
      FakeWebSocket.instances = []
      originalWebSocket = globalThis.WebSocket
      globalThis.WebSocket = FakeWebSocket as unknown as typeof globalThis.WebSocket
    })

    afterEach(() => {
      globalThis.WebSocket = originalWebSocket
    })

    it('opens the WebSocket against the daemon origin, not the page origin', async () => {
      await act(async () => {
        render(<DaemonCanvasPage daemonBaseUrl={DAEMON_BASE_URL} />, { container: document.body })
      })

      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
      const wsUrl = new URL(FakeWebSocket.instances[0]!.url)
      expect(wsUrl.origin).toBe(new URL(DAEMON_BASE_URL).origin.replace('http:', 'ws:'))
    })
  })
})
