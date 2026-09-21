/**
 * Copy as JSON Canvas, on the DOCUMENT page of a daemon-kept board.
 *
 * The last row of `issues/daemon-document-page-offers-no-document-actions`,
 * and the one whose absence was recorded as DELIBERATE on a reason that
 * turned out to be false — that the daemon keeper would have to decode a
 * snapshot for this row alone. It holds `canvasValue`, a decoded
 * SpatialCanvas, at the very place it builds its slots.
 *
 * Both directions are here, because a row that is always present and a row
 * that is never present both pass a one-sided test: a board offers it, a note
 * does not. The note case is the one with teeth — `canvasValue` falls back to
 * an empty document on a markdown note, so an ungated row would hand back a
 * well-formed JSON Canvas file whose content is not the note's.
 */
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>, {
    container: document.body,
  })
}

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return { ...actual, listWorkspaces: vi.fn(), listDocuments: vi.fn(), createDocument: vi.fn() }
})

// Background replica work, stubbed for the reason every sibling file stubs it.
vi.mock('../lib/replica-refresh.js', () => ({
  scheduleReplicaRefresh: vi.fn(() => () => {}),
  scheduleReplicaPush: vi.fn(() => () => {}),
}))

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)

function boardSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'spatial')
  writeSpatialCanvas(doc, {
    nodes: [
      {
        id: 'the-node',
        x: 12,
        y: 34,
        width: 100,
        height: 60,
        resource: { mimeType: 'text/markdown', content: 'on the board' },
      },
    ],
    edges: [],
  })
  return doc.export({ mode: 'snapshot' })
}

function noteSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'markdown')
  return doc.export({ mode: 'snapshot' })
}

class FakeBackend implements DocumentBackend {
  constructor(private readonly snapshot: () => Uint8Array) {}
  connect(handlers: DocumentBackendHandlers): void {
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

const writeText = vi.fn(async (_text: string) => {})

async function openDocumentOpsMenu() {
  const trigger = await screen.findByRole('button', { name: 'More actions' })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  return screen.findByRole('menu')
}

async function mountPage(path: string, snapshot: () => Uint8Array): Promise<void> {
  await act(async () => {
    render(
      <DaemonDocumentPage
        daemonBaseUrl="http://127.0.0.1:3099"
        workspaceId="w1"
        path={path}
        createBackend={() => new FakeBackend(snapshot)}
      />,
    )
  })
}

describe('copying a daemon-kept board as JSON Canvas', () => {
  beforeEach(() => {
    window.localStorage.clear()
    writeText.mockClear()
    vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/names')) {
          return new Response(JSON.stringify({ documents: {}, pinned: [] }), { status: 200 })
        }
        return new Response('{}', { status: 404 })
      }),
    )
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [
        { path: 'board', id: 'id-board', updatedAt: '2026-01-01', kind: 'spatial' },
        { path: 'note', id: 'id-note', updatedAt: '2026-01-01', kind: 'markdown' },
      ],
    })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('puts the board on the clipboard, coordinates included', async () => {
    await mountPage('board', boardSnapshot)
    await openDocumentOpsMenu()
    const copy = await screen.findByRole('menuitem', { name: /copy as json canvas/i })
    await act(async () => {
      fireEvent.pointerUp(copy)
    })

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const written = String(writeText.mock.calls[0]?.[0])
    // The EXACT canvas, which is what the row promises: the node, and where
    // it is. A serialisation that lost the geometry would still be valid JSON.
    expect(JSON.parse(written)).toMatchObject({
      nodes: [expect.objectContaining({ id: 'the-node', x: 12, y: 34 })],
    })
  })

  it('offers no such row on a note, which has no canvas to copy', async () => {
    await mountPage('note', noteSnapshot)
    const menu = await openDocumentOpsMenu()
    // The CONTROL: the menu opened and has the rows that are not conditional,
    // so an absent Copy row is the gate working rather than a menu that never
    // rendered.
    expect(await screen.findByRole('menuitem', { name: /duplicate/i })).toBeTruthy()
    expect(menu.textContent).not.toContain('Copy as JSON Canvas')
  })
})
