import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
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
    // And the return half: offline edits ship back on the same moment
    // (decision 3) — the push runs BEFORE the pull so a merge-back cannot
    // read as "my offline edit vanished" between the two.
    const { scheduleReplicaPush } = await import('../lib/replica-refresh.js')
    expect(vi.mocked(scheduleReplicaPush)).toHaveBeenCalled()
    const pushCall = vi.mocked(scheduleReplicaPush).mock.calls[0]?.[0]
    expect(pushCall?.workspaceId).toBe('w1')
    expect(pushCall?.daemonBaseUrl).toBe(DAEMON_BASE_URL)
    expect(vi.mocked(scheduleReplicaPush).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(scheduleReplicaRefresh).mock.invocationCallOrder[0] as number,
    )
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
})
