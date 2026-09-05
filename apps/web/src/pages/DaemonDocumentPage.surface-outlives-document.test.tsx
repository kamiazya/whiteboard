/**
 * The body surface on the DAEMON page, across a document switch this page
 * makes without its props moving.
 *
 * The sibling case on the browser page is
 * `BrowserDocumentPage.dialog-outlives-document.test.tsx`. This one exists
 * separately because the switch arrives differently and the difference is the
 * whole defect: `useDaemonDocumentController` owns its own `path` and
 * `switchDocument`, and five call sites here move the document while
 * `workspaceId`/`path` — the props, and what this page's own mount in
 * App.tsx is keyed on — never change. Scoping the surface to the props reads
 * correct and holds nothing.
 *
 * Both seams driven here are real props of the editor rather than test
 * hooks: `onOpenInEditor` is how a node's body is opened, and
 * `onOpenFileRef` is how following a file-node reference switches document.
 */

import { writeDocumentKind } from '@kamiazya/whiteboard-loro-adapter'
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
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

function render(ui: ReactElement, search = '') {
  return rtlRender(<MemoryRouter initialEntries={[`/${search}`]}>{ui}</MemoryRouter>, {
    container: document.body,
  })
}

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return { ...actual, listWorkspaces: vi.fn(), listDocuments: vi.fn(), createDocument: vi.fn() }
})

let openInEditor: ((nodeId: string, text: string) => void) | null = null
let openFileRef: ((file: string) => void) | null = null
vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (props: {
    canvas: SpatialCanvas
    onOpenInEditor?: (nodeId: string, text: string) => void
    onOpenFileRef?: (file: string) => void
  }) => {
    openInEditor = props.onOpenInEditor ?? null
    openFileRef = props.onOpenFileRef ?? null
    return null
  },
}))

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)

function spatialSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'spatial')
  return doc.export({ mode: 'snapshot' })
}

class FakeBackend implements DocumentBackend {
  connect(handlers: DocumentBackendHandlers): void {
    handlers.onConnected()
    handlers.onSnapshot(spatialSnapshot())
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

describe('the body surface does not outlive its document (daemon)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/names')) {
          return new Response(
            JSON.stringify({ documents: { 'doc-a': 'Doc A', 'doc-b': 'Doc B' }, pinned: [] }),
            { status: 200 },
          )
        }
        if (url.endsWith('/versions') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              version: {
                id: 'v1',
                path: 'doc-a',
                createdAt: '2026-01-01T00:00:00Z',
                elementCount: 0,
                auto: false,
                hasThumbnail: false,
                branchName: 'main',
              },
            }),
            { status: 200 },
          )
        }
        if (url.endsWith('/versions')) {
          return new Response(JSON.stringify({ versions: [] }), { status: 200 })
        }
        return new Response('{}', { status: 404 })
      }),
    )
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [
        { path: 'doc-a', id: 'id-a', updatedAt: '2026-01-01', kind: 'spatial' },
        { path: 'doc-b', id: 'id-b', updatedAt: '2026-01-01', kind: 'spatial' },
      ],
    })
  })
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    openInEditor = null
    openFileRef = null
  })

  it('following a file reference closes a surface opened on the document being left', async () => {
    await act(async () => {
      render(
        <DaemonDocumentPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspaceId="w1"
          path="doc-a"
          createBackend={() => new FakeBackend()}
        />,
      )
    })
    await waitFor(() => expect(openInEditor).not.toBeNull())
    await waitFor(() => expect(openFileRef).not.toBeNull())

    await act(async () => {
      openInEditor?.('n1', 'typed against a node in doc-a')
    })
    expect(
      screen.queryByTestId('node-text-overlay'),
      'the surface did not open, so the switch below would prove nothing',
    ).not.toBeNull()

    // The switch this page makes by itself: the props never move.
    await act(async () => {
      openFileRef?.('id-b')
    })
    // Bounded well inside the per-test budget on purpose: the reset happens
    // during RENDER, so the surface is gone by the commit that follows the
    // switch. A longer wait would turn a failure into a timeout, which says
    // nothing about which invariant broke — measured, it did exactly that.
    for (let i = 0; i < 20 && screen.queryByTestId('node-text-overlay') !== null; i++) {
      await new Promise((r) => setTimeout(r, 25))
    }
    await act(async () => {})

    expect(
      screen.queryByTestId('node-text-overlay'),
      'the body surface is still open after this page switched document under it — scoped to the props, which a controller-driven switch never moves',
    ).toBeNull()
  })

  it('a saved-bookmark badge does not outlive its document', async () => {
    await act(async () => {
      render(
        <DaemonDocumentPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspaceId="w1"
          path="doc-a"
          createBackend={() => new FakeBackend()}
        />,
      )
    })
    await waitFor(() => expect(openFileRef).not.toBeNull())

    // ⌘S opens the history panel with the naming field armed; naming + Enter
    // performs the save this badge reports.
    await act(async () => {
      fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    })
    const field = await screen.findByLabelText('Name this point')
    fireEvent.change(field, { target: { value: 'Milestone' } })
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' })
    })
    await waitFor(() => expect(screen.getByText('Bookmark saved')).toBeTruthy())

    // The switch this page makes by itself; the history panel closes with it.
    await act(async () => {
      openFileRef?.('id-b')
    })
    await waitFor(() => expect(screen.queryByTestId('bookmark-action')).toBeNull())

    // Reopen history on the ARRIVED document via the toolbar (not ⌘S, which
    // would arm the naming field and hide the badge either way).
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    await screen.findByTestId('bookmark-action')
    expect(
      screen.queryByText('Bookmark saved'),
      "a 'saved' badge earned on the departed document is still lit under the arrived one",
    ).toBeNull()
  })

  it('a variation notice about the document being left does not follow the switch', async () => {
    // `?v` is not stripped by a switch — `switchDocument` sets the path and
    // nothing else — and no branch of the variation effect clears the
    // NOTICE. So `Variation «nope» was not found`, which is a statement
    // about doc-a, was still on screen over doc-b.
    //
    // A message naming a document the reader has left is the same class as
    // the dialog above, one surface over: it reads as being about what is in
    // front of them.
    await act(async () => {
      render(
        <DaemonDocumentPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspaceId="w1"
          path="doc-a"
          createBackend={() => new FakeBackend()}
        />,
        '?v=nope',
      )
    })
    await waitFor(() => expect(openFileRef).not.toBeNull())
    await waitFor(
      () => expect(screen.queryByTestId('variation-preview-notice')).not.toBeNull(),
      // Without the notice on screen the switch below proves nothing, so
      // this wait is the case's premise rather than part of its assertion.
      { timeout: 3000 },
    )

    await act(async () => {
      openFileRef?.('id-b')
    })

    await waitFor(() => expect(screen.queryByTestId('variation-preview-notice')).toBeNull(), {
      timeout: 2000,
    })
  })
})
