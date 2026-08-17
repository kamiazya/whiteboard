/**
 * A markdown-kind document opened in daemon mode must get the MARKDOWN
 * editor. Before this branch existed the page always mounted SpatialEditor,
 * so a note created by an agent (wb_document_create + wb_body_patch) opened
 * as an empty spatial canvas — and drawing on it corrupted the document.
 */

import {
  writeCoreFacets,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import type {
  CanvasBackend,
  CanvasBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import {
  act,
  cleanup,
  type RenderOptions,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'

function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>, options)
}

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return {
    ...actual,
    listWorkspaces: vi.fn(),
    listCanvases: vi.fn(),
    createCanvas: vi.fn(),
  }
})

const { DaemonCanvasPage } = await import('./DaemonCanvasPage.js')

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListCanvases = vi.mocked(daemonApiClient.listCanvases)

/**
 * A daemon-held markdown document in the shape `wb_document_set` actually
 * writes: the body in the `body` text container, and NOT as a text node of
 * the spatial canvas. The distinction is the whole point of this fixture —
 * an agent-authored document that opened empty here is exactly the interop
 * defect the one-writer rule exists to prevent.
 */
/** A daemon-held spatial document: empty canvas, stored kind, no facets. */
function spatialSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'spatial')
  return doc.export({ mode: 'snapshot' })
}

function markdownSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, '# Hello from an agent')
  writeCoreFacets(doc, { type: 'markdown' })
  writeDocumentKind(doc, 'markdown')
  return doc.export({ mode: 'snapshot' })
}

class FakeBackend implements CanvasBackend {
  handlers: CanvasBackendHandlers | null = null
  constructor(private readonly snapshot: () => Uint8Array = markdownSnapshot) {}
  connect(handlers: CanvasBackendHandlers): void {
    this.handlers = handlers
    handlers.onConnected()
    handlers.onSnapshot(this.snapshot())
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

/**
 * Serves the daemon's `/api/workspaces/:id/names` surface, which is where a
 * document's display NAME lives (the canvas summary carries only a path).
 * Anything else the page fetches answers 404 so a missing stub shows up as a
 * failed expectation rather than as a hang.
 */
function stubNames(names: { canvases: Record<string, string>; pinned: string[] }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/names')) {
        return new Response(JSON.stringify(names), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }),
  )
}

describe('DaemonCanvasPage markdown documents', () => {
  beforeEach(() => {
    window.localStorage.clear()
    stubNames({ canvases: { 'agent-note': 'Agent verification note' }, pinned: [] })
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListCanvases.mockResolvedValue({
      canvases: [{ path: 'agent-note', id: 'id-note', updatedAt: '2026-01-01', kind: 'markdown' }],
    })
  })
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('opens a markdown-kind document in the markdown editor, never the spatial editor', async () => {
    await act(async () => {
      render(
        <DaemonCanvasPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspaceId="w1"
          path="agent-note"
          createBackend={() => new FakeBackend()}
        />,
        { container: document.body },
      )
    })

    // The markdown editor's source pane is the positive signal; the spatial
    // editor's absence is what stops a stray stroke from corrupting the doc.
    await waitFor(() => expect(screen.getByTestId('markdown-source-wrap')).toBeTruthy())
    expect(screen.queryByTestId('spatial-editor')).toBeNull()
  })

  it('shows the daemon-held body text', async () => {
    await act(async () => {
      render(
        <DaemonCanvasPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspaceId="w1"
          path="agent-note"
          createBackend={() => new FakeBackend()}
        />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(document.body.textContent).toContain('Hello from an agent'))
  })

  // The title box shows the WORKSPACE's display name for this document —
  // never a `title` read out of its content, which ADR-0009 decision 2
  // forbids and `storedCoreFacetsSchema` no longer even has room for. The
  // name comes from the daemon's `/names` endpoint, the same one the canvas
  // dropdown renames through.
  it("shows the workspace's display name for the open document", async () => {
    await act(async () => {
      render(
        <DaemonCanvasPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspaceId="w1"
          path="agent-note"
          createBackend={() => new FakeBackend()}
        />,
        { container: document.body },
      )
    })
    await waitFor(() => {
      const title = screen.getByPlaceholderText('Untitled') as HTMLInputElement
      expect(title.value).toBe('Agent verification note')
    })
  })

  // Facets ARE OKF frontmatter, so a markdown document gets the disclosure
  // and a spatial one does not — ADR-0009 decision 3, the same split the
  // browser-local page makes. `readCoreFacets` answering `undefined` for a
  // spatial document is what makes the second case fall out rather than
  // needing a flag.
  it('offers the facets disclosure for a markdown document', async () => {
    await act(async () => {
      render(
        <DaemonCanvasPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspaceId="w1"
          path="agent-note"
          createBackend={() => new FakeBackend()}
        />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByLabelText('Properties')).toBeTruthy())
  })

  it('hides the facets disclosure for a spatial document', async () => {
    mockListCanvases.mockResolvedValue({
      canvases: [{ path: 'board', id: 'id-board', updatedAt: '2026-01-01', kind: 'spatial' }],
    })
    stubNames({ canvases: { board: 'A board' }, pinned: [] })
    await act(async () => {
      render(
        <DaemonCanvasPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspaceId="w1"
          path="board"
          createBackend={() => new FakeBackend(spatialSnapshot)}
        />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByPlaceholderText('Untitled')).toBeTruthy())
    expect(screen.queryByLabelText('Properties')).toBeNull()
  })

  it('falls back to the path when the workspace has stored no name', async () => {
    stubNames({ canvases: {}, pinned: [] })
    await act(async () => {
      render(
        <DaemonCanvasPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspaceId="w1"
          path="agent-note"
          createBackend={() => new FakeBackend()}
        />,
        { container: document.body },
      )
    })
    await waitFor(() => {
      const title = screen.getByPlaceholderText('Untitled') as HTMLInputElement
      expect(title.value).toBe('agent-note')
    })
  })
})
