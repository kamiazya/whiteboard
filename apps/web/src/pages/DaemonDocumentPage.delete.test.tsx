import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { DESTRUCTIVE_COPY } from '../lib/destructive-copy.js'
import {
  markdownWorkspaceSnapshot,
  openDocumentOpsMenu,
  renderInRouter,
} from '../test-utils/daemon-page-harness.js'

const DOCUMENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const COPY_ID = '01J9ZC8XK4PQRS7TVWXY0ABCDE'

const render = (ui: ReactElement) => renderInRouter(ui, { container: document.body })

vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
    'getDocumentSnapshot',
    'deleteDocument',
    'createDocument',
    'updateDocument',
    'setDocumentDisplayName',
  ]),
)

const snapshotFor = (path: string): Uint8Array =>
  markdownWorkspaceSnapshot({
    path,
    documentId: path === 'agent-note' ? DOCUMENT_ID : COPY_ID,
    body: `# Body of ${path}`,
  })

const constructed: { workspaceId: string; path: string }[] = []

vi.mock('@kamiazya/whiteboard-daemon-client/sse-backend', async () =>
  (await import('../test-utils/daemon-page-harness.js')).fakeSseBackendModule({
    onConstruct: (workspaceId, path) => constructed.push({ workspaceId, path }),
    snapshotFor: (path) => snapshotFor(path),
  }),
)

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

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
