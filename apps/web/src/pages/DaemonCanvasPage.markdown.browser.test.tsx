/**
 * Daemon-mode markdown 導線 (real CodeMirror): a markdown-kind document
 * served by the daemon opens in the markdown editor, and typing into it
 * reaches the backend as ordinary local updates on the SAME doc the
 * snapshot hydrated — the sync session's forwarding, not a second write
 * path. The backend is fake (this suite's subject is the page wiring, not
 * the transport); MarkdownEditor is REAL because CodeMirror's input path
 * is exactly what jsdom cannot exercise.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import {
  markdownBodyFromCanvas,
  readSpatialCanvas,
  writeCoreFacets,
  writeDocumentKind,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-canvas-workspace'
import type {
  CanvasBackend,
  CanvasBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import '../index.css'

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
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

vi.mock('../components/spatial-editor/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/spatial-editor/index.js')>()
  return {
    ...actual,
    SpatialEditor: (_props: { canvas: SpatialCanvas }) => <div data-testid="mock-spatial-editor" />,
  }
})

const { DaemonCanvasPage } = await import('./DaemonCanvasPage.js')

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListCanvases = vi.mocked(daemonApiClient.listCanvases)

const BODY = '# Hello from an agent'

/** The daemon shape: body as the okf-body node, kind stored on the doc. */
function markdownSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'okf-body', type: 'text', x: 0, y: 0, width: 600, height: 400, text: BODY }],
    edges: [],
  })
  writeCoreFacets(doc, { type: 'markdown' })
  writeDocumentKind(doc, 'markdown')
  return doc.export({ mode: 'snapshot' })
}

class FakeBackend implements CanvasBackend {
  readonly pushed: Uint8Array[] = []
  // The exact bytes the page hydrated from: the replay assertion must
  // import updates into the SAME doc lineage, not a structurally-equal
  // rebuild with different Loro op ids.
  snapshot: Uint8Array = new Uint8Array()
  connect(handlers: CanvasBackendHandlers): void {
    handlers.onConnected()
    this.snapshot = markdownSnapshot()
    handlers.onSnapshot(this.snapshot)
  }
  disconnect(): void {}
  pushLocalUpdate(update: Uint8Array): void {
    this.pushed.push(update)
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

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

describe('DaemonCanvasPage markdown editing', () => {
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

  it('typing into the daemon markdown editor pushes the edit to the backend as a doc update', async () => {
    const backend = new FakeBackend()
    render(
      <DaemonCanvasPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspaceId="w1"
        slug="agent-note"
        createBackend={() => backend}
      />,
    )

    // Markdown editor mounts with the daemon-held body; spatial never does.
    const editable = await waitFor(
      () => {
        const el = document.querySelector('[contenteditable="true"]')
        expect(el).not.toBeNull()
        return el as HTMLElement
      },
      { timeout: 10_000 },
    )
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toBe(BODY)
    })
    expect(screen.queryByTestId('mock-spatial-editor')).toBeNull()

    await userEvent.click(editable)
    await waitFor(() => expect(document.activeElement).toBe(editable), { timeout: 10_000 })
    // A click lands the cursor wherever the pointer hit; pin it to the end
    // so the typed suffix has one deterministic destination.
    await userEvent.keyboard('{Control>}{End}{/Control}')
    await userEvent.keyboard(' — edited here')

    // The edit reaches the backend through the session's own local-update
    // forwarding: replaying pushed updates over the original snapshot must
    // yield the typed body in the okf-body node (the daemon storage shape).
    await waitFor(
      () => {
        expect(backend.pushed.length).toBeGreaterThan(0)
        const replay = new LoroDoc()
        replay.import(backend.snapshot)
        for (const update of backend.pushed) replay.import(update)
        expect(markdownBodyFromCanvas(readSpatialCanvas(replay))).toBe(`${BODY} — edited here`)
      },
      { timeout: 10_000 },
    )
  })
})
