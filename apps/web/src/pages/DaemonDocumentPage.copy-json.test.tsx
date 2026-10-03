import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import {
  FakeDocumentBackend,
  openDocumentOpsMenu,
  renderInRouter,
} from '../test-utils/daemon-page-harness.js'
import { jsonResponse } from '../test-utils/json-response.js'

const render = (ui: ReactElement) => renderInRouter(ui, { container: document.body })

vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
    'createDocument',
  ]),
)

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

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

const writeText = vi.fn(async (_text: string) => {})

async function mountPage(path: string, snapshot: () => Uint8Array): Promise<void> {
  await act(async () => {
    render(
      <DaemonDocumentPage
        daemonBaseUrl="http://127.0.0.1:3099"
        workspaceId="w1"
        path={path}
        createBackend={() => new FakeDocumentBackend(snapshot)}
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
          return jsonResponse({ documents: {}, pinned: [] })
        }
        return jsonResponse({}, 404)
      }),
    )
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [
        { path: 'board', documentId: 'id-board', updatedAt: '2026-01-01', kind: 'spatial' },
        { path: 'note', documentId: 'id-note', updatedAt: '2026-01-01', kind: 'markdown' },
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
