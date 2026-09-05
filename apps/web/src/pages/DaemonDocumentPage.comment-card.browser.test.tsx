// The comment card on the REAL canvas, on the daemon page: a press on a
// bubble opens the conversation, its Close shuts it, and a reply typed into
// its box joins the thread. The component test covers the editor alone; this
// is the page composition around it — the sync session that delivers the
// threads the card is built from, and the chrome the page stacks over the
// canvas.

import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  writeCommentThread,
  writeDocumentKind,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '../index.css'

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

function seededSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'spatial')
  writeSpatialCanvas(doc, {
    nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' }],
    edges: [],
  })
  writeCommentThread(doc, {
    id: 't-open',
    anchor: { kind: 'spatial', x: 400, y: 300 },
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

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  sessionStorage.removeItem('wb.lastTool')
})

/** A press on the bubble, found by the words it draws rather than by a guessed viewport. */
function pressBubble(root: HTMLElement, pointerId: number) {
  const content = root.querySelector('[data-testid="canvas-content"]') as SVGElement
  const textEl = [...content.querySelectorAll('text')].find((el) =>
    el.textContent?.includes('still needs'),
  ) as SVGTextElement
  const r = textEl.getBoundingClientRect()
  const at = { pointerId, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
  fireEvent.pointerDown(root, { button: 0, ...at })
  fireEvent.pointerUp(root, at)
}

it('a press on a bubble opens the card, Close shuts it, and a reply joins the conversation', async () => {
  sessionStorage.setItem('wb.lastTool', 'select')
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 404 })),
  )
  render(
    <DaemonDocumentPage
      daemonBaseUrl="http://127.0.0.1:3099"
      workspaceId="w1"
      path="board"
      createBackend={() => new FakeBackend()}
    />,
  )
  const root = (await screen.findByTestId('spatial-editor', undefined, {
    timeout: 15_000,
  })) as HTMLElement
  await waitFor(
    () =>
      expect(root.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
        'still needs a decision',
      ),
    { timeout: 15_000 },
  )

  pressBubble(root, 1)
  await expect.element(page.getByTestId('comment-card')).toBeInTheDocument()

  await userEvent.click(page.getByRole('button', { name: 'Close' }))
  await vi.waitFor(() => expect(document.querySelector('[data-testid="comment-card"]')).toBeNull())

  pressBubble(root, 2)
  await expect.element(page.getByTestId('comment-card')).toBeInTheDocument()
  await userEvent.click(page.getByLabelText('Reply'))
  await userEvent.keyboard('take the second option')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await expect.element(page.getByText('take the second option')).toBeInTheDocument()
})
