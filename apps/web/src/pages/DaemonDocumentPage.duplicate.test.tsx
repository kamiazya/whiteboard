/**
 * Duplicate, on the DOCUMENT page of a daemon-kept document.
 *
 * The verb existed on the daemon INDEX row menu and nowhere else, while the
 * browser keeper offered it from the document page — a difference by SURFACE
 * that no test was ever asked to notice
 * (`issues/daemon-document-page-offers-no-document-actions`, and
 * `document-menu-parity.test.ts` is what makes the next one fail).
 *
 * What this pins that the lib-level suite cannot: the row exists, it is the
 * page's own in-flight guard that stops a second copy, and the page FOLLOWS
 * the copy — a duplicate that leaves you on the original reads as one that
 * did not happen.
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

const SOURCE = {
  path: 'agent-note',
  id: DOCUMENT_ID,
  updatedAt: '2026-01-01',
  kind: 'markdown' as const,
  displayName: 'Agent note',
}

async function openDocumentOpsMenu() {
  const trigger = await screen.findByRole('button', { name: 'More actions' })
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  return screen.findByRole('menu')
}

describe('duplicating a daemon-kept document from its own page', () => {
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
    mockSetDisplayName.mockResolvedValue({ documents: {}, pinned: [] })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('creates the copy as the source KIND and follows it', async () => {
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

    // Once the copy exists, the list the page re-reads holds both.
    mockListDocuments.mockResolvedValue({
      documents: [
        SOURCE,
        {
          path: 'agent-note-copy',
          id: COPY_ID,
          updatedAt: '2026-01-02',
          kind: 'markdown',
          displayName: 'Agent note (copy)',
        },
      ],
    })

    await openDocumentOpsMenu()
    // The item is resolved BEFORE the act: RTL turns the act environment off
    // inside findBy*, so a query nested in act fails as an act complaint
    // naming neither.
    const duplicate = await screen.findByRole('menuitem', { name: /duplicate/i })
    await act(async () => {
      fireEvent.pointerUp(duplicate)
    })

    await waitFor(() =>
      expect(mockCreateDocument).toHaveBeenCalledWith(
        expect.anything(),
        'http://127.0.0.1:3099',
        'w1',
        'agent-note-copy',
        'markdown',
      ),
    )
    // Following the copy is the half a lib test cannot see: a duplicate that
    // leaves you on the original reads as one that never happened.
    await waitFor(() => expect(constructed.at(-1)?.path).toBe('agent-note-copy'))
  })

  it('disables its own row while a copy is in flight, and re-enables it after', async () => {
    let release: (() => void) | undefined
    mockGetSnapshot.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
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
    // The CONTROL: enabled before the click. Without it, an assertion that the
    // row is disabled during flight passes against a row that is disabled
    // always — or against a menu that never opened.
    expect(duplicate.getAttribute('aria-disabled')).not.toBe('true')
    await act(async () => {
      fireEvent.pointerUp(duplicate)
    })
    await waitFor(() => expect(mockGetSnapshot).toHaveBeenCalledTimes(1))

    // Radix closes the menu on select, so the row is read again from a
    // re-opened one rather than through the reference that went with it.
    await openDocumentOpsMenu()
    await waitFor(async () =>
      expect(
        (await screen.findByRole('menuitem', { name: /duplicate/i })).getAttribute('aria-disabled'),
      ).toBe('true'),
    )

    await act(async () => {
      release?.()
    })
    await waitFor(() => expect(mockCreateDocument).toHaveBeenCalledTimes(1))
    expect(mockGetSnapshot).toHaveBeenCalledTimes(1)
  })
})
