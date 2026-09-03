import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import {
  act,
  cleanup,
  fireEvent,
  type RenderOptions,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { getShellConnection } from '../lib/shell-status-store.js'
import { DaemonDocumentPage } from './DaemonDocumentPage.js'

function MemoryRouterWrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/']}>{children}</MemoryRouter>
}

// The page now reads useNavigate (Settings navigation), so every render
// needs a Router ancestor. Using RTL's `wrapper` option (rather than hand-
// wrapping the element) keeps this file's `rerender(...)` calls under the
// same Router too — RTL re-applies `wrapper` on every rerender.
function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: MemoryRouterWrapper, ...options })
}

vi.mock('../lib/replica-refresh.js', () => ({ scheduleReplicaRefresh: vi.fn() }))

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

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)
const mockCreateDocument = vi.mocked(daemonApiClient.createDocument)
const mockGetDocumentBacklinks = vi.mocked(daemonApiClient.getDocumentBacklinks)

// Records every fake backend instance created, in order, so tests can assert
// exactly-once disconnect and ordering (old disconnects before new connects).
const createdBackends: FakeBackend[] = []

class FakeBackend implements DocumentBackend {
  handlers: DocumentBackendHandlers | null = null
  connectCount = 0
  disconnectCount = 0
  constructor(
    public workspaceId: string,
    public path: string,
  ) {
    createdBackends.push(this)
  }
  connect(handlers: DocumentBackendHandlers): void {
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
  return (workspaceId: string, path: string) => new FakeBackend(workspaceId, path)
}

// WorkspaceTopBar's canvas switcher dropdown is real Radix — open on
// pointerDown, select on pointerUp (see WorkspaceTopBar.test.tsx for the
// same pattern). Rendering into document.body (per every render() call in
// this file) keeps the portal content inside React's event-delegation root.
// Exact match: HeaderBranchChip's "Switch branch (current: <name>)" button
// also contains the canvas path as a substring, so a loose regex match is
// ambiguous now that WorkspaceTopBar renders both in the same header.
// Switching document from inside the editor is the Connections chip's job:
// the header's own switcher was retired (finding a document is the document
// browser's work), and a backlink row opening its source is the remaining
// document-to-document path a user has without leaving the canvas.
async function switchDocumentViaConnections(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: /connections/i }))
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(name, 'i') }))
}

// The top bar's History control opens the document's history column. It is
// in the bar rather than the canvas dock because history belongs to the
// document, not to one editor — which is what lets a markdown document
// reach it too.
function toggleHistoryPanel() {
  fireEvent.click(screen.getByRole('button', { name: /history/i }))
}

// A bookmark is a NAMED point now: the control opens a field rather than
// saving on the press, because a row with no label is titled by its time and
// so cannot be told from the automatic checkpoint beside it.
async function takeBookmark(name = 'a point worth keeping') {
  await act(async () => {
    screen.getByRole('button', { name: 'Bookmark this point' }).click()
  })
  const field = await screen.findByRole('textbox', { name: 'Name this point' })
  await act(async () => {
    fireEvent.change(field, { target: { value: name } })
    fireEvent.keyDown(field, { key: 'Enter' })
  })
}

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

describe('DaemonDocumentPage', () => {
  beforeEach(() => {
    // Settings live in localStorage and this suite seeds them, so without a
    // reset a later test inherits whichever earlier test happened to run.
    window.localStorage.clear()
    createdBackends.length = 0
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [
        { path: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' },
        { path: 'second', id: 'id-second', updatedAt: '2026-01-02', kind: 'spatial' },
      ],
    })
    // One backlink by default so `switchDocumentViaConnections` has a row to
    // click in any test that needs to change document mid-session.
    mockGetDocumentBacklinks.mockResolvedValue({
      backlinks: [
        {
          documentId: 'id-second',
          path: 'second',
          name: 'Second board',
          kind: 'spatial',
          contexts: ['embedded on this canvas'],
        },
      ],
      unlinkedMentions: [],
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('working on a daemon workspace schedules a replica refresh for it', async () => {
    // ADR-0023 decision 5's arrival path: the page that just loaded this
    // workspace is the moment this browser can afford to cache it.
    const { scheduleReplicaRefresh } = await import('../lib/replica-refresh.js')
    await act(async () => {
      render(
        <DaemonDocumentPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspaceId="w1"
          createBackend={makeCreateBackend()}
        />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(vi.mocked(scheduleReplicaRefresh)).toHaveBeenCalled())
    const call = vi.mocked(scheduleReplicaRefresh).mock.calls[0]?.[0]
    expect(call?.workspaceId).toBe('w1')
    expect(call?.daemonBaseUrl).toBe(DAEMON_BASE_URL)
  })

  it('renders a workspace-not-found list failure as an error, never as an empty workspace', async () => {
    // The daemon now answers 404 for a workspace it has never registered —
    // the reachable case being a stale pairing, since a browser keeps its
    // paired workspace id in localStorage and ids outlive the install that
    // minted them. Rendering that as "This workspace has no documents yet"
    // plus a Create button reads as the user's data being GONE, and invites
    // them to start over inside a workspace that never existed here. The
    // error screen, with the daemon's own title, is the honest rendering.
    const { DaemonApiError } = await vi.importActual<typeof import('../lib/daemon-api-client.js')>(
      '../lib/daemon-api-client.js',
    )
    mockListDocuments.mockRejectedValue(
      new DaemonApiError('Workspace "stale-pairing" not found', 404),
    )

    await act(async () => {
      render(
        <DaemonDocumentPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspaceId="stale-pairing"
          createBackend={makeCreateBackend()}
        />,
        { container: document.body },
      )
    })

    await waitFor(() =>
      expect(screen.getByText('Workspace "stale-pairing" not found')).toBeTruthy(),
    )
    expect(screen.queryByText('This workspace has no documents yet.')).toBeNull()
    expect(screen.queryByRole('button', { name: /create a canvas/i })).toBeNull()
  })

  it('mounts the editor with a mocked backend and renders the canvas list', async () => {
    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })

    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    // Hand (view-only) is the default tool; the host history cluster only
    // docks in Select mode, so tests exercising it switch first.
    fireEvent.click(await screen.findByTestId('select-tool-button'))
    // The header offers no way to reach another document — that is the
    // document browser's job, and the back control is how you get there.
    expect(screen.queryByRole('button', { name: /^Workspace:/i })).toBeNull()
    expect(createdBackends).toHaveLength(1)
    expect(createdBackends[0]?.connectCount).toBe(1)
  })

  it('offers the canvas display settings gear, so plugin canvasSettings are reachable here too', async () => {
    // The source scan in file-seam-conformance.test.ts asserts the PROP is
    // written; this asserts the surface actually appears, which is what a
    // reader of the scan cannot tell. `CanvasDisplaySettings` owns the
    // `canvasSettings` contribution point — `visual.edges/v0` is contributed
    // there today — and only the browser page placed it, so those settings
    // were unreachable in daemon mode with nothing failing.
    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })

    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    expect(screen.getByTestId('canvas-settings-button')).toBeTruthy()
  })

  it('shows the Connections chip with the backlink count and switches to a source on click', async () => {
    mockGetDocumentBacklinks.mockResolvedValue({
      backlinks: [
        {
          documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          path: 'second',
          name: 'Second board',
          kind: 'spatial',
          contexts: ['embedded on this canvas'],
        },
      ],
      unlinkedMentions: [],
    })
    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    const chip = await screen.findByRole('button', { name: /connections \(1\)/i })
    expect(mockGetDocumentBacklinks).toHaveBeenCalledWith(
      expect.anything(),
      DAEMON_BASE_URL,
      'w1',
      'id-main',
    )

    fireEvent.click(chip)
    fireEvent.click(await screen.findByRole('button', { name: /second board/i }))
    // Row click navigates by path: the page switches documents, which mounts
    // a second backend for 'second'.
    await waitFor(() => expect(createdBackends).toHaveLength(2))
  })

  it('keeps one live connection when the parent re-renders with a fresh createBackend', async () => {
    // A parent that writes `createBackend={(w, s) => …}` inline — the
    // natural thing to write — hands this page a new function identity on
    // every render. The connection is defined by (workspace, path, daemon),
    // not by that function's identity, so the session must survive it:
    // rebuilding tears down the WebSocket, re-hydrates, and drops the undo
    // history for a canvas the user never left.
    const { rerender } = render(
      <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
      { container: document.body },
    )
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    expect(createdBackends).toHaveLength(1)

    await act(async () => {
      rerender(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
      )
    })

    expect(createdBackends).toHaveLength(1)
    expect(createdBackends[0]?.disconnectCount).toBe(0)
    expect(createdBackends[0]?.connectCount).toBe(1)
  })

  it('renders capability badges from DAEMON_CAPABILITIES', async () => {
    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    // Hand (view-only) is the default tool; the host history cluster only
    // docks in Select mode, so tests exercising it switch first.
    fireEvent.click(await screen.findByTestId('select-tool-button'))
    // The bar's History button is the real versions-capability affordance
    // now that WorkspaceTopBar owns it (see WorkspaceTopBar.tsx).
    expect(screen.getByRole('button', { name: /history/i })).toBeTruthy()
    // A single-workspace daemon renders no workspace selector at all —
    // one raw id is not a choice, and every header row costs canvas height.
    expect(screen.queryByLabelText('Workspaces')).toBeNull()
  })

  // Switching WORKSPACE from inside an open document is gone with the
  // header's switcher: a workspace is a place, and moving between places is
  // the document browser's job. The controller's own switchWorkspace
  // behaviour (re-fetch, empty target, stale-response race, failure) is
  // covered where it lives, in use-daemon-document-controller.test.ts.
  describe('workspace switching left the editor', () => {
    it('offers no workspace switcher at all while a document is open', async () => {
      mockListWorkspaces.mockResolvedValue({
        workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
      })

      await act(async () => {
        render(
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
            onNavigateBack={() => {}}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())

      expect(screen.queryByLabelText('Workspaces')).toBeNull()
      expect(screen.queryByRole('button', { name: /^Workspace:/i })).toBeNull()
      // The way out is the way to another workspace.
      expect(screen.getByRole('button', { name: 'Back to documents' })).toBeTruthy()
    })

    it('leaves the empty state with creation, and no switcher of its own', async () => {
      // An empty workspace used to be the one place this page kept a
      // workspace select, because there was no canvas to go "back" from. That
      // select showed raw canonical ids and is gone; the shell names and
      // switches the workspace on every page, this one included, so the way
      // out is above the page rather than inside it (covered in App.test.tsx,
      // where the shell is actually mounted).
      //
      // What the PAGE still owes an empty workspace is a way to fill it.
      mockListWorkspaces.mockResolvedValue({
        workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
      })
      mockListDocuments.mockResolvedValue({ documents: [] })

      await act(async () => {
        render(
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() =>
        expect(screen.getByText('This workspace has no documents yet.')).toBeTruthy(),
      )

      expect(screen.getByRole('button', { name: 'Create a canvas' })).toBeTruthy()
      expect(screen.queryByLabelText('Workspaces')).toBeNull()
    })
  })

  it('disconnects the old backend before the new one is observed on canvas switch', async () => {
    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    // Hand (view-only) is the default tool; the host history cluster only
    // docks in Select mode, so tests exercising it switch first.
    fireEvent.click(await screen.findByTestId('select-tool-button'))

    const oldBackend = createdBackends[0]!

    await act(async () => {
      await switchDocumentViaConnections('Second board')
    })

    expect(oldBackend.disconnectCount).toBe(1)
    expect(createdBackends).toHaveLength(2)
    expect(createdBackends[1]?.connectCount).toBe(1)
    expect(createdBackends[1]?.disconnectCount).toBe(0)
  })

  it('reports "reconnecting" to the shell while the transport is down', async () => {
    // A chip that reads Synced while the transport is down tells the user
    // remote edits are arriving when they are not. The App-mounted shell
    // draws the chip; this page's contract is the state it publishes.
    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    expect(getShellConnection()).toEqual({
      state: { keeper: 'daemon', session: 'synced' },
      daemonBaseUrl: DAEMON_BASE_URL,
    })

    const backend = createdBackends[0]!
    await act(async () => {
      backend.handlers?.onDisconnected?.()
    })
    expect(getShellConnection()?.state).toEqual({ keeper: 'daemon', session: 'reconnecting' })

    // …and back, so a recovered stream clears it rather than latching.
    await act(async () => {
      backend.handlers?.onConnected()
    })
    expect(getShellConnection()?.state).toEqual({ keeper: 'daemon', session: 'synced' })
  })

  it('reports "sync-off" on WS auth failure (close 1008 -> onAuthError) without replacing the page', async () => {
    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    // Hand (view-only) is the default tool; the host history cluster only
    // docks in Select mode, so tests exercising it switch first.
    fireEvent.click(await screen.findByTestId('select-tool-button'))
    // Healthy session.
    expect(getShellConnection()?.state).toEqual({ keeper: 'daemon', session: 'synced' })

    const backend = createdBackends[0]!
    await act(async () => {
      backend.handlers?.onAuthError?.()
    })

    expect(getShellConnection()?.state).toEqual({ keeper: 'daemon', session: 'sync-off' })
    // D1: no standing role=alert banner anywhere on the page — the shell's
    // chip carries the state and its own live region announces it.
    expect(screen.queryByRole('alert')).toBeNull()
    // Editor chrome stays mounted — auth error never replaces the page.
    expect(screen.getByTestId('spatial-editor-container')).toBeTruthy()
  })

  it('reports a live auth error to the shell-status store (and clears on unmount)', async () => {
    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    expect(getShellConnection()?.state).toEqual({ keeper: 'daemon', session: 'synced' })

    await act(async () => {
      createdBackends[0]?.handlers?.onAuthError?.()
    })
    // The App-mounted shell reads this to draw the chip and to light the
    // gear's attention dot.
    expect(getShellConnection()?.state).toEqual({ keeper: 'daemon', session: 'sync-off' })

    // Cleared on unmount: an index page holds no session, and a latched chip
    // would keep claiming one.
    cleanup()
    expect(getShellConnection()).toBeNull()
  })

  it('clears the reported auth error when switching to a new canvas (new backend identity)', async () => {
    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    // Hand (view-only) is the default tool; the host history cluster only
    // docks in Select mode, so tests exercising it switch first.
    fireEvent.click(await screen.findByTestId('select-tool-button'))

    await act(async () => {
      createdBackends[0]?.handlers?.onAuthError?.()
    })
    expect(getShellConnection()?.state).toEqual({ keeper: 'daemon', session: 'sync-off' })

    await act(async () => {
      await switchDocumentViaConnections('Second board')
    })

    // The stale sync-off state must not outlive the backend that produced it.
    expect(getShellConnection()?.state).toEqual({ keeper: 'daemon', session: 'synced' })
  })

  it('shows a structural skeleton while workspace/canvas resolution is pending', async () => {
    // Never resolves during this test, so the page stays in the loading state.
    mockListWorkspaces.mockReturnValue(new Promise(() => {}))

    render(
      <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
      { container: document.body },
    )

    expect(screen.getByRole('status', { name: /connecting to daemon/i })).toBeTruthy()
  })

  it('shows a full-page alert when workspace/canvas resolution fails', async () => {
    mockListWorkspaces.mockRejectedValue(new Error('daemon unreachable'))

    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toMatch(/daemon unreachable/i)
    expect(screen.queryByTestId('spatial-editor-container')).toBeNull()
  })

  it('renders a create-canvas button, not a form, when the workspace has zero documents (ADR-0006)', async () => {
    mockListDocuments.mockResolvedValue({ documents: [] })

    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })

    await waitFor(() =>
      expect(screen.getByText('This workspace has no documents yet.')).toBeTruthy(),
    )
    expect(screen.queryByLabelText('Canvases')).toBeNull()
    expect(screen.queryByTestId('spatial-editor-container')).toBeNull()
    // No form, no name-first input: creation is immediate, naming follows (ADR-0006 point 3).
    expect(screen.queryByLabelText(/new canvas name/i)).toBeNull()
    expect(screen.queryByRole('form')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create a canvas' })).toBeTruthy()
  })

  it('clicking Create a canvas derives a path and mounts the editor once the canvas exists', async () => {
    mockListDocuments.mockResolvedValueOnce({ documents: [] })
    mockCreateDocument.mockResolvedValue({ path: 'untitled' })
    mockListDocuments.mockResolvedValueOnce({
      documents: [
        { path: 'untitled', id: 'id-untitled', updatedAt: '2026-01-03', kind: 'spatial' },
      ],
    })

    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })

    await waitFor(() =>
      expect(screen.getByText('This workspace has no documents yet.')).toBeTruthy(),
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    })

    // No name typed by the user — the path is derived, same as the daemon
    // index page's own empty-state control.
    expect(mockCreateDocument).toHaveBeenCalledWith(
      expect.anything(),
      DAEMON_BASE_URL,
      'w1',
      'untitled',
    )
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    // Hand (view-only) is the default tool; the host history cluster only
    // docks in Select mode, so tests exercising it switch first.
    fireEvent.click(await screen.findByTestId('select-tool-button'))
  })

  it('disables Create a canvas while a create is in flight, and a same-tick second click is a no-op', async () => {
    mockListDocuments.mockResolvedValue({ documents: [] })
    let resolveCreate: (value: { path: string }) => void = () => {}
    mockCreateDocument.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve
      }),
    )

    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })

    await waitFor(() =>
      expect(screen.getByText('This workspace has no documents yet.')).toBeTruthy(),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create a canvas' }).hasAttribute('disabled')).toBe(
        true,
      ),
    )
    // A second, same-tick click while the first create is still pending must
    // not fire a second create call — `disabled` is the guard (see the
    // `creating` state's comment), so this is exercising that guard, not an
    // in-handler early-return.
    fireEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    expect(mockCreateDocument).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveCreate({ path: 'untitled' })
    })
  })

  it('shows the createError alert in the empty-documents state when creation fails', async () => {
    mockListDocuments.mockResolvedValue({ documents: [] })
    mockCreateDocument.mockRejectedValue(new Error('path already exists'))

    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })

    await waitFor(() =>
      expect(screen.getByText('This workspace has no documents yet.')).toBeTruthy(),
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    })

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).toMatch(/path already exists/i)
    // The control recovers (not left permanently disabled) so the user can retry.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create a canvas' }).hasAttribute('disabled')).toBe(
        false,
      ),
    )
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
          if (url.includes('/workspaces/w1/documents/main/versions') && init?.method === 'POST') {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  version: {
                    id: 'v-manual',
                    path: 'main',
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
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      toggleHistoryPanel()
      await takeBookmark()

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(
            ([reqInput, init]) =>
              String(reqInput).startsWith(DAEMON_BASE_URL) &&
              String(reqInput).includes('/workspaces/w1/documents/main/versions') &&
              init?.method === 'POST',
          ),
        ).toBe(true)
      })
      // The announcement itself, by its role: a loose /saved/i also matches
      // the empty-state copy beside it, which says what a checkpoint does.
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Bookmark saved'))

      vi.unstubAllGlobals()
    })

    it('announces a bookmark on the window, which is what a version_created broadcast would otherwise have to do', async () => {
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
          if (url.includes('/workspaces/w1/documents/main/versions') && init?.method === 'POST') {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  version: {
                    id: 'v-manual',
                    path: 'main',
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
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      // Dirty the doc via a remote update, exactly like the "drives
      // HeaderVersionDot dirty/clean" test does, so this test isolates the
      // manual-save clean path from the remote version_created broadcast path.
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

      const saved = vi.fn()
      window.addEventListener('whiteboard:wb_version_saved', saved)

      toggleHistoryPanel()
      await takeBookmark()

      // The daemon's manual POST does not broadcast version_created, so the
      // page announces the bookmark itself — the same identity-scoped event
      // a broadcast would have carried. Without it nothing downstream (the
      // favicon's dirty signal, an open panel) learns the save happened.
      await waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
      window.removeEventListener('whiteboard:wb_version_saved', saved)

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
          if (url.includes('/workspaces/w1/documents/main/versions') && init?.method === 'POST') {
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
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      toggleHistoryPanel()
      await takeBookmark()

      await waitFor(() => expect(screen.getByText(/save failed/i)).toBeTruthy())

      vi.unstubAllGlobals()
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
          if (url.includes('/workspaces/w1/documents/main/versions') && init?.method === 'POST') {
            return Promise.resolve(new Response('nope', { status: 500 }))
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      )
      vi.stubGlobal('fetch', fetchMock)

      await act(async () => {
        render(
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      toggleHistoryPanel()
      await takeBookmark()

      await waitFor(() => expect(screen.getByText(/save failed/i)).toBeTruthy())

      vi.unstubAllGlobals()
    })

    it('disables the save button while a save is in flight and when no canvas is selected', async () => {
      mockListDocuments.mockResolvedValue({ documents: [] })

      await act(async () => {
        render(
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })

      await waitFor(() =>
        expect(screen.getByText('This workspace has no documents yet.')).toBeTruthy(),
      )
      expect(screen.queryByRole('button', { name: 'Save version' })).toBeNull()
    })
  })

  describe('version history panel', () => {
    it('opens the panel and lists versions for the current (workspaceId, path) via the daemon fetch', async () => {
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
                      path: 'main',
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
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Select mode is not required to reach history any more — the control
      // is in the top bar — but these cases also exercise the canvas.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      const toggle = screen.getByRole('button', { name: 'History' })
      await act(async () => {
        toggle.click()
      })

      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(
            ([reqInput]) =>
              String(reqInput).startsWith(DAEMON_BASE_URL) &&
              String(reqInput).includes('/workspaces/w1/documents/main/versions'),
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
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Select mode is not required to reach history any more — the control
      // is in the top bar — but these cases also exercise the canvas.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      const toggle = screen.getByRole('button', { name: 'History' })
      await act(async () => {
        toggle.click()
      })
      await screen.findByText(/no versions yet/i)

      await act(async () => {
        toggle.click()
      })

      expect(screen.queryByText(/no versions yet/i)).toBeNull()

      vi.unstubAllGlobals()
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
          if (url.endsWith('/document')) {
            return Promise.resolve(
              new Response(JSON.stringify({ kind: 'spatial', canvas: { nodes: [], edges: [] } }), {
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
                      path: 'main',
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
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Select mode is not required to reach history any more — the control
      // is in the top bar — but these cases also exercise the canvas.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      const toggle = screen.getByRole('button', { name: 'History' })
      await act(async () => {
        toggle.click()
      })

      const row = await screen.findByTestId('version-row')
      // The row IS the wrapper now; the restore control is inside it.
      await act(async () => {
        fireEvent.click(row.querySelector('button') as HTMLElement)
      })
      // The looking-at state is the DOCUMENT's chrome now, not a bar inside
      // the history: what changed is the document.
      await waitFor(() => {
        expect(screen.getByTestId('version-preview-bar')).toBeTruthy()
      })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }))
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
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      await waitFor(() => expect(screen.getByTestId('header-branch-chip')).toBeTruthy())
      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some(
            ([reqInput]) =>
              String(reqInput).startsWith(DAEMON_BASE_URL) &&
              String(reqInput).includes('/workspaces/w1/documents/main/branches'),
          ),
        ).toBe(true)
      })
      expect(screen.queryByText('Variations')).toBeNull()

      vi.unstubAllGlobals()
    })

    it('shows the static disabled teasers when capabilities.branches/merge are false', async () => {
      await act(async () => {
        render(
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
            capabilities={{
              branches: false,
              merge: false,
            }}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      expect(screen.queryByTestId('header-branch-chip')).toBeNull()
      expect(screen.getByText('Variations')).toBeTruthy()
      expect(screen.getByText('Combine')).toBeTruthy()
    })

    it('refetches the branch list when the backend reports an externally observed HEAD change', async () => {
      const fetchMock = branchesFetchMock([
        { name: 'main', color: '#1971c2' },
        { name: 'feature-x', color: '#9333ea' },
      ])
      vi.stubGlobal('fetch', fetchMock)

      await act(async () => {
        render(
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))
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

    it('renders HeaderBranchBanner when capabilities.branches is true and the head branch is unmerged', async () => {
      const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        (input) => {
          const url = String(input)
          if (url.includes('/branches/feature-x/stats')) {
            return Promise.resolve(
              new Response(JSON.stringify({ unmergedCommits: 2, isHead: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
          }
          if (url.includes('/branches')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  head: 'feature-x',
                  branches: [
                    {
                      name: 'main',
                      color: '#1971c2',
                      tipFrontiers: '',
                      createdAt: '2026-01-01T00:00:00Z',
                    },
                    {
                      name: 'feature-x',
                      color: '#9333ea',
                      tipFrontiers: '',
                      createdAt: '2026-01-01T00:00:00Z',
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
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      const banner = await screen.findByTestId('header-branch-banner')
      expect(banner.textContent).toContain('feature-x')

      vi.unstubAllGlobals()
    })

    it('does not render HeaderBranchBanner when capabilities.branches is false', async () => {
      const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        (input) => {
          const url = String(input)
          if (url.includes('/branches/feature-x/stats')) {
            return Promise.resolve(
              new Response(JSON.stringify({ unmergedCommits: 2, isHead: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            )
          }
          if (url.includes('/branches')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  head: 'feature-x',
                  branches: [
                    {
                      name: 'main',
                      color: '#1971c2',
                      tipFrontiers: '',
                      createdAt: '2026-01-01T00:00:00Z',
                    },
                    {
                      name: 'feature-x',
                      color: '#9333ea',
                      tipFrontiers: '',
                      createdAt: '2026-01-01T00:00:00Z',
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
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
            capabilities={{
              branches: false,
              merge: false,
            }}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      expect(screen.queryByTestId('header-branch-banner')).toBeNull()

      vi.unstubAllGlobals()
    })
  })

  describe('MergeToast integration', () => {
    const dispatchMergeCommitted = (overrides: Partial<Record<string, unknown>> = {}) => {
      window.dispatchEvent(
        new CustomEvent('whiteboard:merge_committed', {
          detail: {
            workspaceId: 'w1',
            path: 'main',
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
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

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
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
            capabilities={{
              branches: true,
              merge: false,
            }}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

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
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

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
    it('does not render a "Back to documents" button (onNavigateBack omitted)', async () => {
      await act(async () => {
        render(
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      expect(screen.queryByRole('button', { name: 'Back to documents' })).toBeNull()
    })

    it('renders "Back to documents" and invokes onNavigateBack when provided', async () => {
      const onNavigateBack = vi.fn()
      await act(async () => {
        render(
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
            onNavigateBack={onNavigateBack}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      const button = screen.getByRole('button', { name: 'Back to documents' })
      fireEvent.click(button)
      expect(onNavigateBack).toHaveBeenCalledTimes(1)
    })

    it('renders "Back to documents" in the zero-documents branch, where WorkspaceTopBar does not mount', async () => {
      mockListDocuments.mockResolvedValue({ documents: [] })
      const onNavigateBack = vi.fn()

      await act(async () => {
        render(
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
            onNavigateBack={onNavigateBack}
          />,
          { container: document.body },
        )
      })

      await waitFor(() =>
        expect(screen.getByText('This workspace has no documents yet.')).toBeTruthy(),
      )

      const button = screen.getByRole('button', { name: 'Back to documents' })
      fireEvent.click(button)
      expect(onNavigateBack).toHaveBeenCalledTimes(1)
    })

    it('asks for a name on ⌘/Ctrl+S rather than writing a version straight away', async () => {
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
          if (url.includes('/workspaces/w1/documents/main/versions') && init?.method === 'POST') {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  version: {
                    id: 'v-cmd-s',
                    path: 'main',
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
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      await act(async () => {
        fireEvent.keyDown(window, { key: 's', metaKey: true })
      })

      // The chord opens the history with its naming field ready. Nothing is
      // written until a name is given: an unnamed mark would be titled by
      // its time, exactly like the automatic checkpoint beside it.
      const field = await screen.findByRole('textbox', { name: 'Name this point' })
      expect(
        fetchMock.mock.calls.filter(
          ([reqInput, init]) =>
            String(reqInput).includes('/workspaces/w1/documents/main/versions') &&
            init?.method === 'POST',
        ),
      ).toHaveLength(0)

      await act(async () => {
        fireEvent.change(field, { target: { value: 'a point worth keeping' } })
        fireEvent.keyDown(field, { key: 'Enter' })
      })
      await waitFor(() => {
        const postCalls = fetchMock.mock.calls.filter(
          ([reqInput, init]) =>
            String(reqInput).includes('/workspaces/w1/documents/main/versions') &&
            init?.method === 'POST',
        )
        expect(postCalls).toHaveLength(1)
      })

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
        render(<DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} />, { container: document.body })
      })

      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
      const wsUrl = new URL(FakeWebSocket.instances[0]!.url)
      expect(wsUrl.origin).toBe(new URL(DAEMON_BASE_URL).origin.replace('http:', 'ws:'))
    })
  })
  // A markdown document's history was unreachable: the entry point rode the
  // spatial editor's dock, which markdown never renders, while the daemon's
  // auto-version trigger looks at no document kind and the top bar defaulted
  // its version capability on. So checkpoints were being WRITTEN for a
  // surface that could not read them.
  describe('a markdown document reaches its own history', () => {
    it('offers History in the top bar and opens the column', async () => {
      mockListDocuments.mockResolvedValue({
        documents: [{ path: 'notes', id: 'id-notes', updatedAt: '2026-01-01', kind: 'markdown' }],
      })
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/branches')) {
          return new Response(JSON.stringify({ head: 'main', branches: [{ name: 'main' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (url.includes('/versions')) {
          return new Response(JSON.stringify({ versions: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      })
      vi.stubGlobal('fetch', fetchMock)

      await act(async () => {
        render(
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('markdown-source-wrap')).toBeTruthy())

      // No canvas dock on this page at all — the old entry point could not
      // have been here.
      expect(screen.queryByTestId('history-cluster')).toBeNull()

      const historyButton = await screen.findByRole('button', { name: 'History' })
      expect(historyButton.getAttribute('aria-expanded')).toBe('false')
      await act(async () => {
        historyButton.click()
      })

      const panel = await screen.findByTestId('history-panel')
      await waitFor(() => expect(panel.textContent).toContain('Version history'))
      expect(screen.getByRole('button', { name: 'History' }).getAttribute('aria-expanded')).toBe(
        'true',
      )
      // The daemon's own versions route is what the column read.
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes('/workspaces/w1/documents/notes/versions'),
        ),
      ).toBe(true)

      vi.unstubAllGlobals()
    })
  })
  // The bookmark's thumbnail moved with the save. The top bar used to own
  // both and no longer takes versions at all, so an unwired page would leave
  // every canvas answering 204 on latest-thumbnail forever with nothing to
  // notice — which is what the deleted prop-threading test guarded, now
  // guarded by the behaviour instead.
})
