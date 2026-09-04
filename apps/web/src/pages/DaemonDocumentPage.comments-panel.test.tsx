/**
 * DaemonDocumentPage's annotation layer (ADR-0026), jsdom mirror of
 * BrowserDocumentPage.comments-panel.browser.test.tsx's core interactions.
 *
 * What this asserts that the panel's own component test cannot is the
 * WIRING: a thread stored in the document's threads plane reaches the panel
 * through this page's sync session, and a reply typed into the rail travels
 * back through that same session rather than a second write door. Real
 * geometry (the opener's position relative to the editor surface) is a
 * `web-browser` concern — see DaemonDocumentPage.comments-panel.browser.test.tsx.
 */
import {
  readCommentThreads,
  writeCommentThread,
  writeCoreFacets,
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
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
  within,
} from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VersionsBackendContext } from '../contexts/VersionsBackendContext.js'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import type { VersionsBackend } from '../lib/versions-backend.js'

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
    getDocumentBacklinks: vi.fn(),
  }
})

vi.mock('../lib/replica-refresh.js', () => ({
  scheduleReplicaRefresh: vi.fn(),
  scheduleReplicaPush: vi.fn(),
}))

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)
const mockGetDocumentBacklinks = vi.mocked(daemonApiClient.getDocumentBacklinks)

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

/**
 * Serves `/names` (the workspace's display-name surface) and `/branches`
 * (`useBranches`, always enabled on the daemon page's `DAEMON_HISTORY_
 * CAPABILITIES`) so the History panel used by the preview test below has
 * something real to render; everything else answers 404 rather than hang.
 */
function stubDaemonFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/names')) {
        return new Response(JSON.stringify({ documents: {}, pinned: [] }), { status: 200 })
      }
      if (url.includes('/branches')) {
        return new Response(
          JSON.stringify({
            branches: [
              {
                name: 'main',
                tipFrontiers: '',
                color: '#3b82f6',
                createdAt: '2026-01-01T00:00:00.000Z',
              },
            ],
            head: 'main',
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 404 })
    }),
  )
}

/**
 * Threads seeded straight onto the document root — the shape an INJECTED
 * backend produces here, since `createBackend` sends `contentDocumentId:
 * undefined` (see DaemonDocumentPage.tsx's `backendState` memo), unlike a
 * real per-document connection scoped through `documentContainers`.
 */
function seededSpatialSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, { nodes: [], edges: [] })
  writeCommentThread(doc, {
    id: 't-open',
    anchor: { kind: 'spatial', x: 20, y: 30 },
    status: 'open',
    messages: [{ id: 'm1', body: 'still needs a decision' }],
  })
  writeCommentThread(doc, {
    id: 't-done',
    anchor: { kind: 'spatial', x: 40, y: 50 },
    status: 'resolved',
    messages: [{ id: 'm2', body: 'settled last week' }],
  })
  // Anchored to a node the (empty) canvas does not contain — orphaned, not
  // merely unplaced (ADR-0026 decision 4).
  writeCommentThread(doc, {
    id: 't-orphan',
    anchor: { kind: 'spatial', nodeId: 'n-deleted', x: 60, y: 70 },
    status: 'open',
    messages: [{ id: 'm3', body: 'about a node that was deleted' }],
  })
  return doc.export({ mode: 'snapshot' })
}

function markdownSnapshotWithThread(): Uint8Array {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, 'is this still true?')
  writeCoreFacets(doc, { type: 'markdown' })
  writeDocumentKind(doc, 'markdown')
  writeCommentThread(doc, {
    id: 't-note',
    anchor: { kind: 'text', quote: { exact: 'is this still true?' }, start: 0, end: 20 },
    status: 'open',
    messages: [{ id: 'm-note', body: 'is this still true?' }],
  })
  return doc.export({ mode: 'snapshot' })
}

class FakeBackend implements DocumentBackend {
  handlers: DocumentBackendHandlers | null = null
  readonly pushLocalUpdateCalls: Uint8Array[] = []
  constructor(private readonly snapshot: () => Uint8Array) {}
  connect(handlers: DocumentBackendHandlers): void {
    this.handlers = handlers
    handlers.onConnected()
    handlers.onSnapshot(this.snapshot())
  }
  disconnect(): void {}
  pushLocalUpdate(bytes: Uint8Array): void {
    this.pushLocalUpdateCalls.push(bytes)
  }
  getFile(): Promise<Blob | null> {
    return Promise.resolve(null)
  }
  putFile(): Promise<void> {
    return Promise.resolve()
  }
  sendClientReady(): void {}
  sendExportResponse(): void {}
}

async function renderSpatial(backend: FakeBackend = new FakeBackend(seededSpatialSnapshot)) {
  await act(async () => {
    render(
      <DaemonDocumentPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspaceId="w1"
        path="board"
        createBackend={() => backend}
      />,
      { container: document.body },
    )
  })
  return backend
}

/**
 * The rail, scoped. The real SpatialEditor (unmocked, unlike the browser
 * test's mock) draws its own SVG bubble for every thread it is handed, so an
 * unscoped `getByText` on a thread's body matches twice — once in the rail,
 * once on the canvas. Only the rail is this file's subject.
 */
function panel() {
  return within(screen.getByTestId('comments-panel'))
}

describe('DaemonDocumentPage comments panel', () => {
  beforeEach(() => {
    window.localStorage.clear()
    stubDaemonFetch()
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [{ path: 'board', id: 'id-board', updatedAt: '2026-01-01', kind: 'spatial' }],
    })
    mockGetDocumentBacklinks.mockResolvedValue({ backlinks: [], unlinkedMentions: [] })
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('opens a rail listing this document conversations, open ones first and by default', async () => {
    await renderSpatial()
    // Closed by default: the panel answers a question the reader asks,
    // rather than taking a rail's width from everyone who never asks it.
    expect(screen.queryByTestId('comments-panel')).toBeNull()

    fireEvent.click(await screen.findByRole('button', { name: /comments/i }))
    await waitFor(() => expect(panel().getByText('still needs a decision')).toBeTruthy())
    // Resolved is one filter away, not on screen by default.
    expect(panel().queryByText('settled last week')).toBeNull()
  })

  it('counts the open conversations on the opener and reflects the rail in aria-pressed', async () => {
    await renderSpatial()
    // One of three threads is resolved; a badge counting all of them would
    // report work that is done as work outstanding.
    const opener = await screen.findByRole('button', { name: /comments, 2 open/i })
    expect(opener.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(opener)
    await screen.findByTestId('comments-panel')
    expect(opener.getAttribute('aria-pressed')).toBe('true')
  })

  it('marks a thread whose node is gone, but not one anchored to bare coordinates', async () => {
    await renderSpatial()
    fireEvent.click(await screen.findByRole('button', { name: /comments/i }))

    await waitFor(() => expect(screen.getByTestId('thread-orphaned-t-orphan')).toBeTruthy())
    expect(screen.queryByTestId('thread-orphaned-t-open')).toBeNull()
  })

  it('replies from the rail through the sync session, with a fresh message id', async () => {
    // Captured once: a SECOND call to seededSpatialSnapshot() below would
    // build its threads container from an independent LoroDoc with no
    // common ancestor with the session's own, and Loro merges two such
    // creations under the same key to ONE of them — silently discarding the
    // reply this test exists to observe (see comment-threads.ts's own note
    // on writeCommentThread).
    const seed = seededSpatialSnapshot()
    const backend = await renderSpatial(new FakeBackend(() => seed))
    fireEvent.click(await screen.findByRole('button', { name: /comments/i }))
    fireEvent.click(panel().getByText('still needs a decision'))

    fireEvent.change(panel().getByRole('textbox', { name: /reply/i }), {
      target: { value: 'decided: ship it' },
    })
    fireEvent.click(panel().getByRole('button', { name: /^reply$/i }))

    await waitFor(() => expect(panel().getByText('decided: ship it')).toBeTruthy())

    // The write travelled the session's own path — replaying every update
    // the FakeBackend recorded onto a copy of the seed reproduces the same
    // reply, under an id distinct from every seeded message.
    const replay = new LoroDoc()
    replay.import(seed)
    for (const bytes of backend.pushLocalUpdateCalls) replay.import(bytes)
    const thread = readCommentThreads(replay).find((t) => t.id === 't-open')
    const reply = thread?.messages.find((m) => m.body === 'decided: ship it')
    expect(reply?.id).toBeDefined()
    expect(new Set(thread?.messages.map((m) => m.id)).size).toBe(thread?.messages.length)
  })

  it("lists a markdown document's conversations from the same session, and replies through it", async () => {
    mockListDocuments.mockResolvedValue({
      documents: [{ path: 'note', id: 'id-note', updatedAt: '2026-01-01', kind: 'markdown' }],
    })
    await act(async () => {
      render(
        <DaemonDocumentPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspaceId="w1"
          path="note"
          createBackend={() => new FakeBackend(markdownSnapshotWithThread)}
        />,
        { container: document.body },
      )
    })

    // Daemon markdown has no `markdownDoc`-style fallback — every document
    // kind reads its conversations off the ONE sync session (unlike
    // BrowserDocumentPage, whose markdown documents get no backend at all).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /comments, 1 open/i })).toBeTruthy(),
    )
    fireEvent.click(screen.getByRole('button', { name: /comments/i }))
    await waitFor(() => expect(panel().getByText('is this still true?')).toBeTruthy())

    fireEvent.click(panel().getByText('is this still true?'))
    fireEvent.change(panel().getByRole('textbox', { name: /reply/i }), {
      target: { value: 'no, we changed it' },
    })
    fireEvent.click(panel().getByRole('button', { name: /^reply$/i }))
    await waitFor(() => expect(panel().getByText('no, we changed it')).toBeTruthy())
  })

  it('keeps the rail visible under a version preview, but withholds the reply box', async () => {
    const fakeVersionsBackend: VersionsBackend = {
      list: async () => [
        {
          id: 'v1',
          path: 'board',
          createdAt: '2026-01-01T00:00:00.000Z',
          elementCount: 0,
          label: 'a point',
          auto: false,
          hasThumbnail: false,
          branchName: 'main',
        },
      ],
      loadPast: async () => ({ kind: 'spatial', canvas: { nodes: [], edges: [] } }),
      save: async () => {
        throw new Error('not exercised by this test')
      },
      restore: async () => {},
      putThumbnail: async () => {},
      loadThumbnail: async () => null,
    }

    await act(async () => {
      render(
        <VersionsBackendContext.Provider value={fakeVersionsBackend}>
          <DaemonDocumentPage
            daemonBaseUrl={DAEMON_BASE_URL}
            workspaceId="w1"
            path="board"
            createBackend={() => new FakeBackend(seededSpatialSnapshot)}
          />
        </VersionsBackendContext.Provider>,
        { container: document.body },
      )
    })

    fireEvent.click(await screen.findByRole('button', { name: /comments/i }))
    fireEvent.click(panel().getByText('still needs a decision'))
    await waitFor(() => panel().getByRole('textbox', { name: /reply/i }))

    fireEvent.click(await screen.findByRole('button', { name: /history/i }))
    const row = (await screen.findAllByTestId('version-row'))[0]
    const activate = row?.querySelector('button')
    expect(activate, 'no interactive control on the version row').not.toBeNull()
    fireEvent.click(activate as HTMLButtonElement)

    // A reply is a write to the LIVE document, and the editor surface is
    // replaced by DocumentPreview during a preview — the rail must not offer
    // a control that would write against a state that is not the document's.
    await waitFor(() => expect(panel().queryByRole('textbox', { name: /reply/i })).toBeNull())
    expect(panel().getByText('still needs a decision')).toBeTruthy()
  })
})

/** Every thread resolved: the zero-open branch of the opener's label. */
function allResolvedSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, { nodes: [], edges: [] })
  writeCommentThread(doc, {
    id: 't-settled',
    anchor: { kind: 'spatial', x: 20, y: 30 },
    status: 'resolved',
    messages: [{ id: 'm-settled', body: 'settled last week' }],
  })
  return doc.export({ mode: 'snapshot' })
}

describe('DaemonDocumentPage comments opener with zero open threads', () => {
  it("reads plain 'Comments' and carries no count badge", async () => {
    await renderSpatial(new FakeBackend(allResolvedSnapshot))
    const opener = await screen.findByRole('button', { name: 'Comments' })
    // The badge is the only digit the opener ever renders; zero open = none.
    expect(opener.textContent ?? '').not.toMatch(/\d/)
  })
})
