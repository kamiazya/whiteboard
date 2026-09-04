/**
 * The comments panel on the daemon page (ADR-0026 decision 5), real-browser
 * geometry only — the interaction surface (rail contents, reply routing,
 * orphaned marking, preview gating) is already pinned at the jsdom layer in
 * DaemonDocumentPage.comments-panel.test.tsx. What THIS file adds is the one
 * thing jsdom cannot check: the opener's real position relative to the
 * editor surface, mirroring the case that caught BrowserDocumentPage's own
 * overlay defect (see BrowserDocumentPage.comments-panel.browser.test.tsx).
 *
 * SpatialEditor is mocked — the subject is the document-level surface, not
 * the canvas.
 */
import { writeCommentThread } from '@kamiazya/whiteboard-loro-adapter'
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../index.css'

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (_props: { canvas: SpatialCanvas }) => (
    <div data-testid="mock-spatial-editor" style={{ height: '100%', width: '100%' }} />
  ),
}))

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return {
    ...actual,
    listWorkspaces: vi.fn(async () => ({ workspaces: [{ workspaceId: 'w1' }] })),
    listDocuments: vi.fn(async () => ({
      documents: [{ path: 'board', id: 'id-board', updatedAt: '2026-01-01', kind: 'spatial' }],
    })),
    createDocument: vi.fn(),
    getDocumentBacklinks: vi.fn(async () => ({ backlinks: [], unlinkedMentions: [] })),
  }
})

vi.mock('../lib/replica-refresh.js', () => ({
  scheduleReplicaRefresh: vi.fn(),
  scheduleReplicaPush: vi.fn(),
}))

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

/** One open thread, seeded at document root — matches how an injected `createBackend` scopes a connection (see DaemonDocumentPage.comments-panel.test.tsx's own note on `contentDocumentId`). */
function seededSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeCommentThread(doc, {
    id: 't-open',
    anchor: { kind: 'spatial', x: 20, y: 30 },
    status: 'open',
    messages: [{ id: 'm1', body: 'still needs a decision' }],
  })
  return doc.export({ mode: 'snapshot' })
}

class FakeBackend implements DocumentBackend {
  handlers: DocumentBackendHandlers | null = null
  connect(handlers: DocumentBackendHandlers): void {
    this.handlers = handlers
    handlers.onConnected()
    handlers.onSnapshot(seededSnapshot())
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

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('opens the rail from the document actions row, without the opener overlaying the editor surface', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 404 })),
  )

  render(
    <DaemonDocumentPage
      daemonBaseUrl={DAEMON_BASE_URL}
      workspaceId="w1"
      path="board"
      createBackend={() => new FakeBackend()}
    />,
  )

  const surface = await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })
  const opener = await screen.findByRole('button', { name: /comments/i })

  // Geometric, not merely a class name: floated over the surface's top-right
  // corner, this control sat on top of whatever chrome the mounted editor
  // puts there — measured on the browser page, the markdown editor's own
  // catalog trigger, which then could not be clicked at all.
  const a = opener.getBoundingClientRect()
  const b = surface.getBoundingClientRect()
  const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  expect({ overlaps, opener: a.toJSON(), surface: b.toJSON() }).toMatchObject({ overlaps: false })

  await userEvent.click(opener)
  await waitFor(() => expect(screen.getByText('still needs a decision')).toBeInTheDocument(), {
    timeout: 15_000,
  })
})
