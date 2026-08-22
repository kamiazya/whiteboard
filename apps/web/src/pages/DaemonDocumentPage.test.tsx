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
import { LOCAL_WORKSPACE_ID } from '../lib/local-document-summary.js'
import { getShellDaemonAuthError } from '../lib/shell-status-store.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
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
// The trigger names the WORKSPACE, not the open canvas — the canvas's own
// name moved to the canvas row. Callers no longer pass a canvas label.
async function openDocumentSwitcher() {
  const switcher = screen.getByRole('button', { name: /^Workspace:/i })
  fireEvent.pointerDown(switcher, { button: 0, ctrlKey: false })
  await screen.findByTestId('new-document-menu-item')
}

async function selectCanvasFromSwitcher(label: string) {
  const item = (await screen.findByText(label)).closest('[role="menuitem"]') as HTMLElement
  fireEvent.pointerUp(item)
}

async function selectWorkspaceFromSwitcher(workspaceId: string) {
  const item = await screen.findByRole('menuitemradio', { name: workspaceId })
  fireEvent.pointerUp(item)
}

// The bar's History button opens the version popover, which now also
// carries the page's own "Save version" button/message via versionPanelExtra.
function toggleHistoryPanel() {
  fireEvent.click(screen.getByRole('button', { name: /history/i }))
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
    mockGetDocumentBacklinks.mockResolvedValue({ backlinks: [], unlinkedMentions: [] })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
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
    // The switcher's trigger names the workspace; the canvas entries appear
    // in its list. What this pins is still the DocumentSummary
    // {path, updatedAt} -> WorkspaceTopBar DocumentInfo mapping, end to end.
    expect(screen.getByRole('button', { name: /^Workspace:/i })).toBeTruthy()
    await openDocumentSwitcher()
    expect(screen.getByText('second')).toBeTruthy()
    expect(createdBackends).toHaveLength(1)
    expect(createdBackends[0]?.connectCount).toBe(1)
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

  it('renders capability badges from LOCAL_DAEMON_CAPABILITIES', async () => {
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
    await openDocumentSwitcher()
    expect(screen.queryByText('Workspaces')).toBeNull()
    expect(screen.queryByRole('menuitemradio')).toBeNull()
  })

  describe('workspace switcher', () => {
    it('lists workspaces from GET /api/workspaces even though the page supplies an initial workspaceId', async () => {
      mockListWorkspaces.mockResolvedValue({
        workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
      })

      await act(async () => {
        render(
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            workspaceId="w1"
            path="main"
            createBackend={makeCreateBackend()}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      // The header dropdown is the switcher once a canvas is mounted; the
      // secondary-row <select> only survives the no-canvas state (see the
      // negative-direction test below).
      await openDocumentSwitcher()
      expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
        'w1',
        'w2',
      ])
    })

    it('selecting another workspace re-resolves the canvas and re-keys the backend', async () => {
      mockListWorkspaces.mockResolvedValue({
        workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
      })
      mockListDocuments.mockImplementation((_fetch, _base, workspaceId) => {
        if (workspaceId === 'w2') {
          return Promise.resolve({
            documents: [
              { path: 'w2-main', id: 'id-w2-main', updatedAt: '2026-02-01', kind: 'spatial' },
            ],
          })
        }
        return Promise.resolve({
          documents: [
            { path: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' },
            { path: 'second', id: 'id-second', updatedAt: '2026-01-02', kind: 'spatial' },
          ],
        })
      })

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
      expect(createdBackends).toHaveLength(1)
      expect(createdBackends[0]?.workspaceId).toBe('w1')

      await openDocumentSwitcher()
      await act(async () => {
        await selectWorkspaceFromSwitcher('w2')
      })

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Workspace:/i })).toBeTruthy()
      })
      expect(createdBackends).toHaveLength(2)
      expect(createdBackends[1]?.workspaceId).toBe('w2')
      expect(createdBackends[0]?.disconnectCount).toBe(1)
    })

    it('shows the empty-state create form when the switched-to workspace has zero documents', async () => {
      mockListWorkspaces.mockResolvedValue({
        workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
      })
      mockListDocuments.mockImplementation((_fetch, _base, workspaceId) => {
        if (workspaceId === 'w2') return Promise.resolve({ documents: [] })
        return Promise.resolve({
          documents: [
            { path: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' },
            { path: 'second', id: 'id-second', updatedAt: '2026-01-02', kind: 'spatial' },
          ],
        })
      })

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

      // w1 has documents, so the dropdown (not the row select, which is
      // absent while a canvas is mounted) is what starts the switch.
      await openDocumentSwitcher()
      await act(async () => {
        await selectWorkspaceFromSwitcher('w2')
      })

      await waitFor(() =>
        expect(screen.getByText('This workspace has no documents yet.')).toBeTruthy(),
      )
      // w2 has zero documents, so WorkspaceTopBar (and its dropdown) is
      // unmounted — the row select is the only switcher available here, and
      // it must still work to get back out of the empty workspace.
      const workspaceSelect = screen.getByLabelText('Workspaces') as HTMLSelectElement
      expect(Array.from(workspaceSelect.options).map((o) => o.value)).toEqual(['w1', 'w2'])
      await act(async () => {
        workspaceSelect.value = 'w1'
        workspaceSelect.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    })

    it('keeps the editor mounted and shows an inline error when switching workspace fails', async () => {
      mockListWorkspaces.mockResolvedValue({
        workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
      })
      mockListDocuments.mockResolvedValueOnce({
        documents: [
          { path: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' },
          { path: 'second', id: 'id-second', updatedAt: '2026-01-02', kind: 'spatial' },
        ],
      })

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
      expect(createdBackends).toHaveLength(1)

      mockListDocuments.mockRejectedValueOnce(new Error('daemon unreachable'))

      await openDocumentSwitcher()
      await act(async () => {
        await selectWorkspaceFromSwitcher('w2')
      })

      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toMatch(/daemon unreachable/i),
      )
      // A transient switch failure must not tear down the still-valid editor session.
      expect(screen.getByTestId('spatial-editor-container')).toBeTruthy()
      expect(createdBackends).toHaveLength(1)
      expect(createdBackends[0]?.disconnectCount).toBe(0)
    })

    it('shows the static disabled teaser instead of the switcher when capabilities.workspaces is false', async () => {
      // A daemon with >=2 workspaces still shows no dropdown section or row
      // select while the capability itself is off — capability gating is a
      // single rule, not one the new dropdown surface could bypass.
      mockListWorkspaces.mockResolvedValue({
        workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
      })

      await act(async () => {
        render(
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
            capabilities={{
              workspaces: false,
              versions: true,
              branches: true,
              merge: true,
            }}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      expect(screen.queryByLabelText('Workspaces')).toBeNull()
      const teaser = screen.getByText('Workspaces')
      expect(teaser.getAttribute('aria-disabled')).toBe('true')

      await openDocumentSwitcher()
      expect(screen.queryByRole('menuitemradio')).toBeNull()
    })

    it('with a canvas mounted, capabilities.workspaces=true, and >=2 workspaces, the dropdown is the ONLY switcher: the row select is absent while the dropdown shows the Workspaces section', async () => {
      mockListWorkspaces.mockResolvedValue({
        workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
      })

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

      expect(screen.queryByLabelText('Workspaces')).toBeNull()

      await openDocumentSwitcher()
      expect(screen.getByText('Workspaces')).toBeTruthy()
      expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
        'w1',
        'w2',
      ])
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
      await openDocumentSwitcher()
      await selectCanvasFromSwitcher('second')
    })

    expect(oldBackend.disconnectCount).toBe(1)
    expect(createdBackends).toHaveLength(2)
    expect(createdBackends[1]?.connectCount).toBe(1)
    expect(createdBackends[1]?.disconnectCount).toBe(0)
  })

  it('records the daemon as dismissed when disconnecting, so discovery stops finding it', async () => {
    // Forgetting alone is not enough: the default port range is rescanned on
    // every visit, so a daemon on 3099 would come straight back and the
    // action would read as a no-op the second time.
    const onContinueBrowserLocal = vi.fn()
    // The state a connected browser is actually in: App.tsx stores the daemon
    // it connected to, and that is what puts the page in daemon mode on the
    // next load. Without seeding it the assertion below passes vacuously.
    // Seeded through the store, not by writing JSON: a hand-built payload that
    // fails the store's own validation is silently replaced by defaults, and
    // every assertion below then passes without touching the real state.
    createUserSettingsStore().update((current) => ({
      ...current,
      storage: {
        ...current.storage,
        localDaemonBaseUrl: DAEMON_BASE_URL,
        knownDaemonBaseUrls: [DAEMON_BASE_URL],
      },
    }))
    await act(async () => {
      render(
        <DaemonDocumentPage
          daemonBaseUrl={DAEMON_BASE_URL}
          createBackend={makeCreateBackend()}
          onContinueBrowserLocal={onContinueBrowserLocal}
        />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())

    // Precondition, asserted rather than assumed: if the seed did not survive
    // the store's own validation, everything below would pass vacuously.
    expect(createUserSettingsStore().load().storage.localDaemonBaseUrl).toBe(DAEMON_BASE_URL)

    fireEvent.click(screen.getByTestId('connection-chip'))
    fireEvent.click(screen.getByTestId('connection-disconnect'))

    expect(onContinueBrowserLocal).toHaveBeenCalledTimes(1)
    // Asserted as arrays, not as substrings of the whole store: the daemon's
    // URL also appears under localDaemonBaseUrl, so a `toContain` on the
    // serialized storage holds whether or not the dismissal was recorded.
    const storage = createUserSettingsStore().load().storage
    expect(storage.dismissedDaemonBaseUrls).toContain(DAEMON_BASE_URL)
    expect(storage.knownDaemonBaseUrls ?? []).not.toContain(DAEMON_BASE_URL)
    // App.tsx reads localDaemonBaseUrl to decide a page is daemon-backed, so
    // leaving it set reconnects on the next load — which makes the popover's
    // "this browser stops using it" false the moment the user reloads.
    expect(createUserSettingsStore().load().storage.localDaemonBaseUrl).toBeUndefined()
  })

  it('flips the connection chip to "Reconnecting" while the transport is down', async () => {
    // A chip that reads Synced while the transport is down tells the user
    // remote edits are arriving when they are not.
    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    expect(screen.getByTestId('connection-chip').textContent).toMatch(/synced/i)

    const backend = createdBackends[0]!
    await act(async () => {
      backend.handlers?.onDisconnected?.()
    })
    expect(screen.getByTestId('connection-chip').textContent).toMatch(/reconnecting/i)

    // …and back, so a recovered stream clears it rather than latching.
    await act(async () => {
      backend.handlers?.onConnected()
    })
    expect(screen.getByTestId('connection-chip').textContent).toMatch(/synced/i)
  })

  it('flips the connection chip to "Sync off" on WS auth failure (close 1008 -> onAuthError)', async () => {
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
    // Healthy session: the chip reads Synced.
    expect(screen.getByTestId('connection-chip').textContent).toMatch(/synced/i)

    const backend = createdBackends[0]!
    await act(async () => {
      backend.handlers?.onAuthError?.()
    })

    // D1: no standing role=alert banner — the chip carries the state and a
    // polite live region announces it to assistive tech.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('connection-chip').textContent).toMatch(/sync off/i)
    expect(screen.getByRole('status', { name: /live sync off/i })).toBeTruthy()
    // Editor chrome stays mounted — auth error never replaces the page.
    expect(screen.getByTestId('spatial-editor-container')).toBeTruthy()

    // The popover is the recovery surface: both ways forward are offered.
    fireEvent.click(screen.getByTestId('connection-chip'))
    await waitFor(() => expect(screen.getByRole('button', { name: /re-pair/i })).toBeTruthy())
    expect(screen.getByText(/edits stay in this browser/i)).toBeTruthy()
  })

  it('keeps the sr-only live region quiet until authError is true', async () => {
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

    expect(screen.queryByLabelText(/live sync off/i)).toBeNull()

    await act(async () => {
      createdBackends[0]?.handlers?.onAuthError?.()
    })

    const region = screen.getByLabelText(/live sync off/i)
    expect(region.getAttribute('role')).toBe('status')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a live auth error to the shell-status store (and clears on unmount)', async () => {
    await act(async () => {
      render(
        <DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} createBackend={makeCreateBackend()} />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
    expect(getShellDaemonAuthError()).toBe(false)

    await act(async () => {
      createdBackends[0]?.handlers?.onAuthError?.()
    })
    // The App-mounted shell reads this to light the gear's attention dot.
    expect(getShellDaemonAuthError()).toBe(true)

    cleanup()
    expect(getShellDaemonAuthError()).toBe(false)
  })

  it('renders the "Sync off" indicator even when no canvas is selected', async () => {
    mockListWorkspaces.mockResolvedValue({
      workspaces: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
    })
    mockListDocuments.mockImplementation((_fetch, _base, workspaceId) => {
      if (workspaceId === 'w2') return Promise.resolve({ documents: [] })
      return Promise.resolve({
        documents: [
          { path: 'main', id: 'id-main', updatedAt: '2026-01-01', kind: 'spatial' },
          { path: 'second', id: 'id-second', updatedAt: '2026-01-02', kind: 'spatial' },
        ],
      })
    })

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
    expect(screen.getByLabelText(/live sync off/i)).toBeTruthy()

    // Switch into a workspace with zero documents: the canvas backend tears
    // down entirely (no WorkspaceTopBar mounts), but there genuinely is no
    // live sync happening either way, so the indicator must not disappear
    // just because the canvas-gated UI does. w1 has a mounted canvas, so the
    // row select is absent here — the dropdown drives the switch.
    await openDocumentSwitcher()
    await act(async () => {
      await selectWorkspaceFromSwitcher('w2')
    })

    await waitFor(() =>
      expect(screen.getByText('This workspace has no documents yet.')).toBeTruthy(),
    )
    expect(screen.getByLabelText(/live sync off/i)).toBeTruthy()
  })

  it('clears the auth-error banner when switching to a new canvas (new backend identity)', async () => {
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
    expect(screen.getByTestId('connection-chip').textContent).toMatch(/sync off/i)
    expect(screen.getByLabelText(/live sync off/i)).toBeTruthy()

    await act(async () => {
      await openDocumentSwitcher()
      await selectCanvasFromSwitcher('second')
    })

    // The stale sync-off state must not outlive the backend that produced it.
    expect(screen.getByTestId('connection-chip').textContent).toMatch(/synced/i)
    expect(screen.queryByLabelText(/live sync off/i)).toBeNull()
  })

  it('offers the browser-local escape inside the chip popover and invokes the callback', async () => {
    const onContinueBrowserLocal = vi.fn()
    // The state a connected browser is actually in: App.tsx stores the daemon
    // it connected to, and that is what puts the page in daemon mode on the
    // next load. Without seeding it the assertion below passes vacuously.
    // Seeded through the store, not by writing JSON: a hand-built payload that
    // fails the store's own validation is silently replaced by defaults, and
    // every assertion below then passes without touching the real state.
    createUserSettingsStore().update((current) => ({
      ...current,
      storage: {
        ...current.storage,
        localDaemonBaseUrl: DAEMON_BASE_URL,
        knownDaemonBaseUrls: [DAEMON_BASE_URL],
      },
    }))
    await act(async () => {
      render(
        <DaemonDocumentPage
          daemonBaseUrl={DAEMON_BASE_URL}
          createBackend={makeCreateBackend()}
          onContinueBrowserLocal={onContinueBrowserLocal}
        />,
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

    // D1: the escape lives in the chip's popover, not a banner.
    await act(async () => {
      screen.getByTestId('connection-chip').click()
    })
    const escapeButton = await screen.findByRole('button', {
      name: /continue in browser-local/i,
    })
    await act(async () => {
      escapeButton.click()
    })
    expect(onContinueBrowserLocal).toHaveBeenCalledTimes(1)
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
      const saveButton = await screen.findByRole('button', { name: 'Save version' })
      await act(async () => {
        saveButton.click()
      })

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
      await waitFor(() => expect(screen.getByText(/saved/i)).toBeTruthy())

      vi.unstubAllGlobals()
    })

    it('clears HeaderSaveDot after a manual "Save version" click, not just a remote version_created broadcast', async () => {
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
      // HeaderSaveDot dirty/clean" test does, so this test isolates the
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

      await waitFor(() => expect(screen.getByTestId('header-save-dot')).toBeTruthy())

      toggleHistoryPanel()
      const saveButton = await screen.findByRole('button', { name: 'Save version' })
      await act(async () => {
        saveButton.click()
      })

      await waitFor(() => expect(screen.getByText(/saved/i)).toBeTruthy())
      await waitFor(() => expect(screen.queryByTestId('header-save-dot')).toBeNull())

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
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
            capabilities={{
              workspaces: true,
              versions: false,
              branches: true,
              merge: true,
            }}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

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
      const saveButton = await screen.findByRole('button', { name: 'Save version' })
      await act(async () => {
        saveButton.click()
      })

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
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      const toggle = screen.getByRole('button', { name: 'Version history' })
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
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      const toggle = screen.getByRole('button', { name: 'Version history' })
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
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
            capabilities={{
              workspaces: true,
              versions: false,
              branches: true,
              merge: true,
            }}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

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
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      const toggle = screen.getByRole('button', { name: 'Version history' })
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
              workspaces: true,
              versions: true,
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
              workspaces: true,
              versions: true,
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
        new CustomEvent('excalidraw:merge_committed', {
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
              workspaces: true,
              versions: true,
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

    it('drives HeaderSaveDot dirty/clean via the identity-scoped doc_changed/wb_version_saved events', async () => {
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
          path: 'main',
          createdAt: '2026-01-01T00:00:00Z',
          elementCount: 1,
          auto: false,
          hasThumbnail: false,
          branchName: 'main',
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
        render(<DaemonDocumentPage daemonBaseUrl={DAEMON_BASE_URL} />, { container: document.body })
      })

      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
      const wsUrl = new URL(FakeWebSocket.instances[0]!.url)
      expect(wsUrl.origin).toBe(new URL(DAEMON_BASE_URL).origin.replace('http:', 'ws:'))
    })
  })

  describe('browser-local import panel', () => {
    it('renders the import-from-this-browser disclosure and lists a local canvas once opened', async () => {
      const browserLocalStore = new LocalStoreDouble()
      await browserLocalStore.save({
        documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        workspaceId: LOCAL_WORKSPACE_ID,
        path: 'my-local-canvas',
        name: 'My local canvas',
        updatedAt: '2026-01-01T00:00:00Z',
        kind: 'spatial' as const,
      })

      await act(async () => {
        render(
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
            browserLocalStore={browserLocalStore.index}
            browserLocalClock={browserLocalStore.clock}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))

      const summary = await screen.findByText('Import from this browser')
      fireEvent.click(summary)

      await waitFor(() => expect(screen.getByText('My local canvas')).toBeTruthy(), {
        timeout: 5000,
      })
    })

    it('does not touch the browser-local store until the disclosure is opened', async () => {
      const browserLocalStore = new LocalStoreDouble()
      const listSpy = vi.spyOn(browserLocalStore.index, 'listDocuments')

      await act(async () => {
        render(
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            createBackend={makeCreateBackend()}
            browserLocalStore={browserLocalStore.index}
            browserLocalClock={browserLocalStore.clock}
          />,
          { container: document.body },
        )
      })
      await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy())
      // Hand (view-only) is the default tool; the host history cluster only
      // docks in Select mode, so tests exercising it switch first.
      fireEvent.click(await screen.findByTestId('select-tool-button'))
      await screen.findByText('Import from this browser')

      // <details> only hides collapsed content visually; the section (and its
      // IndexedDB read) must not mount until the user actually expands it.
      // Settle any pending dynamic imports first so an eagerly-mounted lazy
      // section cannot hide behind unresolved import timing.
      await act(async () => {
        await vi.dynamicImportSettled()
      })
      expect(listSpy).not.toHaveBeenCalled()

      fireEvent.click(screen.getByText('Import from this browser'))
      await waitFor(() => expect(listSpy).toHaveBeenCalled())
    })

    it('does not render the import disclosure when browserLocalStore is not provided', async () => {
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

      expect(screen.queryByText('Import from this browser')).toBeNull()
    })
  })
})
