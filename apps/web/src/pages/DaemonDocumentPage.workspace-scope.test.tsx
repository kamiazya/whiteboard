/**
 * The daemon page's workspace-granularity sync wiring: every listed document
 * is tree-served, so the DEFAULT backend opts into `?scope=workspace` and the
 * sync session is scoped to that document inside the workspace snapshot. An
 * injected backend (every older test, embedders) keeps the per-document
 * session contract unchanged. A URL naming a path the list does not contain
 * gets a not-found state instead of a connection — the per-document lazy
 * empty doc it used to fall back to is retired.
 */

import { act, cleanup, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { markdownWorkspaceSnapshot, renderInRouter } from '../test-utils/daemon-page-harness.js'
import { jsonResponse } from '../test-utils/json-response.js'

const DOCUMENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const render = (ui: ReactElement) => renderInRouter(ui, { container: document.body })

vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
    'createDocument',
  ]),
)

const sseConstructed: { workspaceId: string; path: string }[] = []

vi.mock('@kamiazya/whiteboard-daemon-client/sse-backend', async () =>
  (await import('../test-utils/daemon-page-harness.js')).fakeSseBackendModule({
    onConstruct: (workspaceId, path) => sseConstructed.push({ workspaceId, path }),
    // The workspace-document snapshot the daemon's scope=workspace socket serves.
    snapshotFor: () =>
      markdownWorkspaceSnapshot({
        path: 'agent-note',
        documentId: DOCUMENT_ID,
        body: '# Hello from the workspace document',
      }),
  }),
)

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)
const mockCreateDocument = vi.mocked(daemonApiClient.createDocument)

describe('DaemonDocumentPage workspace-scope sync', () => {
  beforeEach(() => {
    window.localStorage.clear()
    sseConstructed.length = 0
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
    mockListDocuments.mockResolvedValue({
      documents: [
        { path: 'agent-note', id: DOCUMENT_ID, updatedAt: '2026-01-01', kind: 'markdown' },
      ],
    })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('opts the default backend into workspace scope and hydrates the scoped document', async () => {
    await act(async () => {
      render(
        <DaemonDocumentPage
          daemonBaseUrl="http://127.0.0.1:3099"
          workspaceId="w1"
          path="agent-note"
        />,
      )
    })

    await waitFor(() => expect(sseConstructed.length).toBeGreaterThan(0))
    // The body renders — the session found the document INSIDE the workspace
    // snapshot, which is the whole contentDocumentId wiring in one signal.
    await waitFor(() =>
      expect(document.body.textContent).toContain('Hello from the workspace document'),
    )
    expect(screen.getByTestId('markdown-source-wrap')).toBeTruthy()
  })

  it('shows a not-found state for a URL path the list does not contain, instead of connecting', async () => {
    // The per-document contract used to catch this case with a lazily created
    // empty doc, so a stale URL silently minted a blank canvas at the old
    // path on first edit. The honest answer is on the record: nothing at
    // this path, with creating it as an explicit act.
    await act(async () => {
      render(
        <DaemonDocumentPage
          daemonBaseUrl="http://127.0.0.1:3099"
          workspaceId="w1"
          path="deleted-note"
        />,
      )
    })

    await waitFor(() => expect(document.body.textContent).toContain('deleted-note'))
    expect(sseConstructed).toHaveLength(0)

    // The affordance creates THAT path, not a generic untitled one.
    mockCreateDocument.mockResolvedValue({
      workspaceId: 'ws1',
      documentId: '01J9ZC8XK4PQRS7TVWXY0ABCDE',
      path: 'deleted-note',
    })
    const button = screen.getByRole('button', { name: /create/i })
    await act(async () => {
      button.click()
    })
    expect(mockCreateDocument).toHaveBeenCalledWith(
      expect.anything(),
      'http://127.0.0.1:3099',
      'w1',
      'deleted-note',
      'spatial',
    )
  })
})
