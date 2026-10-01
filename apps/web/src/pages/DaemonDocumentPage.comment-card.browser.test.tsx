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
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '../index.css'
import { renderPage } from '../test-utils/daemon-page-harness.js'

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const { daemonApiClientMock, daemonWithOneDocument } = await import(
    '../test-utils/daemon-page-harness.js'
  )
  return daemonApiClientMock(
    importOriginal,
    ['listWorkspaces', 'listDocuments', 'createDocument', 'getDocumentBacklinks'],
    daemonWithOneDocument({ path: 'board', id: 'id-board', kind: 'spatial' }),
  )
})

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

function seededSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'spatial')
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 100, y: 100, width: 200, height: 100, text: 'hello' })],
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
  sendClientReady(): void {}
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
  renderPage(
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
