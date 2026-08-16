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

describe('DaemonCanvasPage markdown documents', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListCanvases.mockResolvedValue({
      canvases: [{ path: 'agent-note', id: 'id-note', updatedAt: '2026-01-01', kind: 'markdown' }],
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

  // No title-slot coverage here, deliberately. This page mounts no identity
  // slot: a document's NAME is the workspace's (ADR-0009 decision 2) and the
  // daemon's canvas summary carries no display name to render. The tests for
  // the title box live with the browser-local page, which has one.
})
