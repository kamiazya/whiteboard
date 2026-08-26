/**
 * The daemon page's workspace-granularity sync wiring (order 7): when the
 * documents summary shows the open document is tree-served (it has an id and
 * a kind), the DEFAULT backend opts into `?scope=workspace` and the sync
 * session is scoped to that document inside the workspace snapshot. An
 * injected backend (every older test, embedders) and a kindless legacy
 * document keep the per-document contract unchanged.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  writeCoreFacets,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentBackendHandlers } from '@kamiazya/whiteboard-mcp/browser-contract'
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'

const DOCUMENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

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
  }
})

/** The workspace-document snapshot the daemon's scope=workspace socket serves. */
function workspaceSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, {
    path: 'agent-note',
    documentId: DOCUMENT_ID,
    kind: 'markdown',
  })
  const containers = documentContainers(doc, DOCUMENT_ID)
  writeMarkdownBody(containers, '# Hello from the workspace document')
  writeCoreFacets(containers, { type: 'markdown' })
  doc.commit()
  return doc.export({ mode: 'snapshot' })
}

const constructed: {
  workspaceId: string
  path: string
  options: { workspaceScope?: boolean } | undefined
}[] = []

vi.mock('@kamiazya/whiteboard-mcp/daemon-backend', () => ({
  DaemonBackend: class {
    constructor(
      workspaceId: string,
      path: string,
      _locationHref: string,
      _apiTransport?: unknown,
      options?: { workspaceScope?: boolean },
    ) {
      constructed.push({ workspaceId, path, options })
      this.options = options
    }
    options: { workspaceScope?: boolean } | undefined
    connect(handlers: DocumentBackendHandlers): void {
      handlers.onConnected()
      handlers.onSnapshot(
        this.options?.workspaceScope
          ? workspaceSnapshot()
          : new Uint8Array(new LoroDoc().export({ mode: 'snapshot' })),
      )
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

const sseConstructed: {
  workspaceId: string
  path: string
  options: { workspaceScope?: boolean } | undefined
}[] = []

vi.mock('@kamiazya/whiteboard-mcp/sse-backend', () => ({
  SseBackend: class {
    constructor(
      workspaceId: string,
      path: string,
      _baseUrl: string,
      _transport?: unknown,
      _streamSource?: unknown,
      options?: { workspaceScope?: boolean },
    ) {
      sseConstructed.push({ workspaceId, path, options })
      this.options = options
    }
    options: { workspaceScope?: boolean } | undefined
    connect(handlers: DocumentBackendHandlers): void {
      handlers.onConnected()
      handlers.onSnapshot(
        this.options?.workspaceScope
          ? workspaceSnapshot()
          : new Uint8Array(new LoroDoc().export({ mode: 'snapshot' })),
      )
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

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')
const { DEV_TRANSPORT_OVERRIDE_KEY } = await import('../lib/dev-transport-override.js')

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)

describe('DaemonDocumentPage workspace-scope sync', () => {
  beforeEach(() => {
    window.localStorage.clear()
    constructed.length = 0
    sseConstructed.length = 0
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

    await waitFor(() => expect(constructed.length).toBeGreaterThan(0))
    expect(constructed[0]?.options?.workspaceScope).toBe(true)
    // The body renders — the session found the document INSIDE the workspace
    // snapshot, which is the whole contentDocumentId wiring in one signal.
    await waitFor(() =>
      expect(document.body.textContent).toContain('Hello from the workspace document'),
    )
    expect(screen.getByTestId('markdown-source-wrap')).toBeTruthy()
  })

  it('opts the SSE transport into workspace scope too, and hydrates the scoped document', async () => {
    window.localStorage.setItem(DEV_TRANSPORT_OVERRIDE_KEY, 'sse')
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
    expect(sseConstructed[0]?.options?.workspaceScope).toBe(true)
    await waitFor(() =>
      expect(document.body.textContent).toContain('Hello from the workspace document'),
    )
  })

  it('keeps a kindless legacy document on the per-document contract', async () => {
    mockListDocuments.mockResolvedValue({
      documents: [{ path: 'agent-note', id: DOCUMENT_ID, updatedAt: '2026-01-01' }],
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
    expect(constructed[0]?.options?.workspaceScope ?? false).toBe(false)
  })
})
