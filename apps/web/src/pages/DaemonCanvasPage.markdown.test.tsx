/**
 * A markdown-kind document opened in daemon mode must get the MARKDOWN
 * editor. Before this branch existed the page always mounted SpatialEditor,
 * so a note created by an agent (wb_document_create + wb_body_patch) opened
 * as an empty spatial canvas — and drawing on it corrupted the document.
 */

import {
  writeCoreFacets,
  writeDocumentKind,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-canvas-workspace'
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
 * writes: the body as the single `okf-body` text node of the spatial
 * canvas (NOT the browser-local `body` text container), plus core facets
 * and the stored kind.
 */
function markdownSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [
      {
        id: 'okf-body',
        type: 'text',
        x: 0,
        y: 0,
        width: 600,
        height: 400,
        text: '# Hello from an agent',
      },
    ],
    edges: [],
  })
  writeCoreFacets(doc, { type: 'markdown', title: 'Agent verification note' })
  writeDocumentKind(doc, 'markdown')
  return doc.export({ mode: 'snapshot' })
}

/** A daemon-held spatial document: empty canvas, stored kind. */
function spatialSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, { nodes: [], edges: [] })
  writeDocumentKind(doc, 'spatial')
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

describe('DaemonCanvasPage markdown documents', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListCanvases.mockResolvedValue({
      canvases: [{ slug: 'agent-note', id: 'id-note', updatedAt: '2026-01-01', kind: 'markdown' }],
    })
  })
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    vi.clearAllMocks()
  })

  it('opens a markdown-kind document in the markdown editor, never the spatial editor', async () => {
    await act(async () => {
      render(
        <DaemonCanvasPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspaceId="w1"
          slug="agent-note"
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
          slug="agent-note"
          createBackend={() => new FakeBackend()}
        />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(document.body.textContent).toContain('Hello from an agent'))
  })

  // The top-bar title slot: canvas identity lives in the merged header row,
  // backed by the sync session's core facets (mirrors the browser-local page).
  it('shows the document title from core facets and the facets disclosure for markdown', async () => {
    await act(async () => {
      render(
        <DaemonCanvasPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspaceId="w1"
          slug="agent-note"
          createBackend={() => new FakeBackend()}
        />,
        { container: document.body },
      )
    })
    await waitFor(() => {
      const title = screen.getByPlaceholderText('Untitled') as HTMLInputElement
      expect(title.value).toBe('Agent verification note')
    })
    // Facets are OKF frontmatter, so a markdown document gets the disclosure.
    expect(screen.getByLabelText('Properties')).toBeTruthy()
  })

  it('hides the facets disclosure for a spatial document (no OKF frontmatter to hold)', async () => {
    mockListCanvases.mockResolvedValue({
      canvases: [{ slug: 'board', id: 'id-board', updatedAt: '2026-01-01', kind: 'spatial' }],
    })
    await act(async () => {
      render(
        <DaemonCanvasPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspaceId="w1"
          slug="board"
          createBackend={() => new FakeBackend(spatialSnapshot)}
        />,
        { container: document.body },
      )
    })
    await waitFor(() => expect(screen.getByPlaceholderText('Untitled')).toBeTruthy())
    expect(screen.queryByLabelText('Properties')).toBeNull()
  })
})
