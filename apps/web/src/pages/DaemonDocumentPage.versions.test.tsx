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

// The top bar's History control opens the document's history column. It is
// in the bar rather than the canvas dock because history belongs to the
// document, not to one editor — which is what lets a markdown document
// reach it too. Awaited: the bar is a lazy chunk, resolved a tick after the
// page mounts, so the first test in a process to reach it finds nothing
// synchronously.
async function toggleHistoryPanel() {
  fireEvent.click(await screen.findByRole('button', { name: /history/i }))
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

// Split from DaemonDocumentPage.test.tsx by topic (version save + history
// panel + markdown history reachability); the mock harness is per-file.
describe('DaemonDocumentPage versions', () => {
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

      await toggleHistoryPanel()
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

      await toggleHistoryPanel()
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

      await toggleHistoryPanel()
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

      await toggleHistoryPanel()
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

      const toggle = await screen.findByRole('button', { name: 'History' })
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

      const toggle = await screen.findByRole('button', { name: 'History' })
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

      const toggle = await screen.findByRole('button', { name: 'History' })
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
      expect(historyButton.getAttribute('aria-pressed')).toBe('false')
      await act(async () => {
        historyButton.click()
      })

      const panel = await screen.findByTestId('history-panel')
      await waitFor(() => expect(panel.textContent).toContain('Version history'))
      expect(screen.getByRole('button', { name: 'History' }).getAttribute('aria-pressed')).toBe(
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
