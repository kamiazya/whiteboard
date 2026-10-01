import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import {
  markdownWorkspaceSnapshot,
  openDocumentOpsMenu,
  renderInRouter,
} from '../test-utils/daemon-page-harness.js'
import { jsonResponse } from '../test-utils/json-response.js'

const DOCUMENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const COPY_ID = '01J9ZC8XK4PQRS7TVWXY0ABCDE'

const render = (ui: ReactElement) => renderInRouter(ui, { container: document.body })

vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
    'getDocumentSnapshot',
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

const SOURCE = {
  path: 'agent-note',
  id: DOCUMENT_ID,
  updatedAt: '2026-01-01',
  kind: 'markdown' as const,
  displayName: 'Agent note',
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
          return jsonResponse({ documents: {}, pinned: [] })
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
