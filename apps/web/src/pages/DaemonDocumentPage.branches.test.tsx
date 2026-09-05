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

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

// Split from DaemonDocumentPage.test.tsx by topic (branches + merge chrome);
// the mock harness is per-file.
describe('DaemonDocumentPage branches', () => {
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
})
