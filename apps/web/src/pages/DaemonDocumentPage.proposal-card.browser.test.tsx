// ADR-0029 decisions 1 and 4, end to end from a person's side: a proposal an
// agent left in the document is drawn ON that document, a press on its bubble
// opens a card saying what it would do, and Adopt changes the board and closes
// the proposal.
//
// The half this covers is storage -> person -> adopted. The half before it —
// an agent's `wb_canvas_edit --mode propose` producing exactly this record —
// is covered through a real stdio MCP client by `pnpm smoke:e2e`, so the
// proposal here is seeded with the same `writeProposal` that tool calls
// rather than re-stated by hand in a shape nothing else writes.
//
// Page composition, not the editor alone: the sync session is what delivers
// the proposal to the canvas and what carries the decision back into the
// document, and neither is visible from a component mount.

import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  writeDocumentKind,
  writeProposal,
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
    nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'the plan' }],
    edges: [],
  })
  writeProposal(doc, {
    id: 'p-move',
    createdAt: '2026-09-06T00:00:00.000Z',
    changes: [
      {
        id: 'node:n1',
        op: 'node.patch',
        status: 'open',
        nodeId: 'n1',
        patch: { x: 600 },
        assumed: { x: 100 },
      },
    ],
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

function contentOf(root: HTMLElement): SVGElement {
  return root.querySelector('[data-testid="canvas-content"]') as SVGElement
}

/** A press on the bubble, found by the words it draws rather than by a guessed viewport. */
function pressBubble(root: HTMLElement, pointerId: number) {
  const textEl = [...contentOf(root).querySelectorAll('text')].find((el) =>
    el.textContent?.includes('proposed change'),
  ) as SVGTextElement
  const r = textEl.getBoundingClientRect()
  const at = { pointerId, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
  fireEvent.pointerDown(root, { button: 0, ...at })
  fireEvent.pointerUp(root, at)
}

/** Where the proposed node is drawn RIGHT NOW — re-queried, never held across the adopt. */
function nodeLeft(root: HTMLElement): number {
  const el = contentOf(root).querySelector('[data-wb-key="n1"]') as SVGGElement
  return el.getBoundingClientRect().left
}

it('an agent’s proposal is drawn in place, and Adopt moves the node and closes it', async () => {
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
  // Drawn on the live document: the bubble says how many changes are waiting.
  await waitFor(() => expect(contentOf(root).textContent).toContain('1 proposed change'), {
    timeout: 15_000,
  })
  const before = nodeLeft(root)

  pressBubble(root, 1)
  await expect.element(page.getByTestId('proposal-card')).toBeInTheDocument()
  // Named by the board's own words, not by an element id.
  await expect.element(page.getByText(/Move .the plan./)).toBeInTheDocument()

  await userEvent.click(page.getByRole('button', { name: 'Adopt' }))

  // The board changed…
  await vi.waitFor(() => expect(nodeLeft(root)).toBeGreaterThan(before + 100), { timeout: 15_000 })
  // …and the proposal is no longer asking: nothing proposal-shaped is drawn.
  await vi.waitFor(() => expect(contentOf(root).textContent).not.toContain('proposed change'))
  expect(document.querySelector('[data-testid="proposal-card"]')).toBeNull()
})
