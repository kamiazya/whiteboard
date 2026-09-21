/**
 * Delete, on the DOCUMENT page of a daemon-kept document.
 *
 * The verb existed on the daemon INDEX row menu and nowhere else, while the
 * browser keeper offered it from the document page — the other half of
 * `issues/daemon-document-page-offers-no-document-actions`, and the entry
 * `document-menu-parity.test.ts` still records as a gap until this lands.
 *
 * What this pins that a lib-level test cannot: the row exists, the dialog
 * says the DAEMON's sentence (versions and branches do not come back), the
 * page moves to what is left, and the dialog does not outlive the document it
 * was opened for — a bare `confirmDelete` boolean confirmed after a switch
 * deletes the OTHER document, which the browser page records as measured.
 */
import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeCoreFacets,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
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
import { DESTRUCTIVE_COPY } from '../lib/destructive-copy.js'

const DOCUMENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const COPY_ID = '01J9ZC8XK4PQRS7TVWXY0ABCDE'

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>, {
    container: document.body,
  })
}

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return {
    ...actual,
    listWorkspaces: vi.fn(),
    listDocuments: vi.fn(),
    getDocumentSnapshot: vi.fn(),
    deleteDocument: vi.fn(),
    createDocument: vi.fn(),
    updateDocument: vi.fn(),
    setDocumentDisplayName: vi.fn(),
  }
})

function snapshotFor(path: string): Uint8Array {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, {
    path,
    documentId: path === 'agent-note' ? DOCUMENT_ID : COPY_ID,
    kind: 'markdown',
  })
  const containers = documentContainers(doc, path === 'agent-note' ? DOCUMENT_ID : COPY_ID)
  writeMarkdownBody(containers, `# Body of ${path}`)
  writeCoreFacets(containers, { type: 'markdown' })
  doc.commit()
  return doc.export({ mode: 'snapshot' })
}

const constructed: { workspaceId: string; path: string }[] = []

vi.mock('@kamiazya/whiteboard-daemon-client/daemon-backend', () => ({
  DaemonBackend: class {
    readonly path: string
    constructor(workspaceId: string, path: string) {
      this.path = path
      constructed.push({ workspaceId, path })
    }
    connect(handlers: DocumentBackendHandlers): void {
      handlers.onConnected()
      handlers.onSnapshot(snapshotFor(this.path))
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
  },
}))

// Background replica work, stubbed for the reason every sibling file stubs
// it: left real it fires mid-test against a fetch mock shaped for something
// else. Each answers the CANCEL the page calls on unmount.
vi.mock('../lib/replica-refresh.js', () => ({
  scheduleReplicaRefresh: vi.fn(() => () => {}),
  scheduleReplicaPush: vi.fn(() => () => {}),
}))

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)
const mockGetSnapshot = vi.mocked(daemonApiClient.getDocumentSnapshot)
const mockCreateDocument = vi.mocked(daemonApiClient.createDocument)
const mockUpdateDocument = vi.mocked(daemonApiClient.updateDocument)
const mockSetDisplayName = vi.mocked(daemonApiClient.setDocumentDisplayName)
const mockDeleteDocument = vi.mocked(daemonApiClient.deleteDocument)

const SOURCE = {
  path: 'agent-note',
  id: DOCUMENT_ID,
  updatedAt: '2026-01-01',
  kind: 'markdown' as const,
  displayName: 'Agent note',
}

/** What the page has to land on once the document it is showing is gone. */
const SIBLING = {
  path: 'other-note',
  id: COPY_ID,
  updatedAt: '2026-01-02',
  kind: 'markdown' as const,
  displayName: 'Other note',
}

async function openDocumentOpsMenu() {
  const trigger = await screen.findByRole('button', { name: 'More actions' })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  return screen.findByRole('menu')
}

describe('deleting a daemon-kept document from its own page', () => {
  beforeEach(() => {
    window.localStorage.clear()
    constructed.length = 0
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
    mockListDocuments.mockResolvedValue({ documents: [SOURCE] })
    mockGetSnapshot.mockResolvedValue(snapshotFor('agent-note'))
    mockCreateDocument.mockImplementation(async (_f, _b, workspaceId, path) => ({
      workspaceId,
      documentId: COPY_ID,
      path,
    }))
    mockUpdateDocument.mockResolvedValue({ ok: true })
    mockDeleteDocument.mockResolvedValue({ ok: true })
    mockSetDisplayName.mockResolvedValue({ documents: {}, pinned: [] })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('deletes through the daemon and moves to what is left', async () => {
    mockListDocuments.mockResolvedValue({ documents: [SOURCE, SIBLING] })
    await act(async () => {
      render(
        <DaemonDocumentPage
          daemonBaseUrl="http://127.0.0.1:3099"
          workspaceId="w1"
          path="agent-note"
        />,
      )
    })
    await waitFor(() => expect(constructed.length).toBeGreaterThan(0))

    await openDocumentOpsMenu()
    const remove = await screen.findByRole('menuitem', { name: /^delete$/i })
    await act(async () => {
      fireEvent.pointerUp(remove)
    })

    const dialog = await screen.findByRole('alertdialog')
    // The DAEMON's sentence, from the one place it is written: a daemon
    // delete loses versions and branches, which the browser's does not say
    // because a browser workspace has none.
    expect(dialog.textContent).toContain(DESTRUCTIVE_COPY['delete-document-daemon']('note'))

    // Once it is gone the list holds only the sibling, which is where the
    // page has to land — a document page has nothing to show otherwise.
    mockListDocuments.mockResolvedValue({ documents: [SIBLING] })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    })

    await waitFor(() =>
      expect(mockDeleteDocument).toHaveBeenCalledWith(
        expect.anything(),
        'http://127.0.0.1:3099',
        'w1',
        'agent-note',
      ),
    )
    await waitFor(() => expect(constructed.at(-1)?.path).toBe('other-note'))
  })

  it('does not let a dialog opened for one document outlive it', async () => {
    mockListDocuments.mockResolvedValue({ documents: [SOURCE, SIBLING] })
    // A duplicate held mid-flight is the in-page switch this test needs: it
    // moves the page to the copy WITHOUT remounting, and it can be started
    // before the dialog opens — which matters, because an open alert dialog
    // takes the rest of the page out of the accessibility tree and the kebab
    // cannot be reached again while it stands.
    let releaseCopy: (() => void) | undefined
    mockGetSnapshot.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseCopy = resolve
      })
      return snapshotFor('agent-note')
    })

    await act(async () => {
      render(
        <DaemonDocumentPage
          daemonBaseUrl="http://127.0.0.1:3099"
          workspaceId="w1"
          path="agent-note"
        />,
      )
    })
    await waitFor(() => expect(constructed.length).toBeGreaterThan(0))

    await openDocumentOpsMenu()
    const duplicate = await screen.findByRole('menuitem', { name: /duplicate/i })
    await act(async () => {
      fireEvent.pointerUp(duplicate)
    })
    await waitFor(() => expect(mockGetSnapshot).toHaveBeenCalledTimes(1))

    await openDocumentOpsMenu()
    const remove = await screen.findByRole('menuitem', { name: /^delete$/i })
    await act(async () => {
      fireEvent.pointerUp(remove)
    })
    expect(await screen.findByRole('alertdialog')).toBeTruthy()

    // The copy lands and the page follows it, with the confirmation still
    // standing. A bare boolean survives that motion, and confirming it would
    // delete the document that ARRIVED — which is what the browser keeper
    // measured before its own reset was written.
    mockListDocuments.mockResolvedValue({
      documents: [SOURCE, SIBLING, { ...SIBLING, path: 'agent-note-copy', id: COPY_ID }],
    })
    await act(async () => {
      releaseCopy?.()
    })
    await waitFor(() => expect(constructed.at(-1)?.path).toBe('agent-note-copy'))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(mockDeleteDocument).not.toHaveBeenCalled()
  })
})
