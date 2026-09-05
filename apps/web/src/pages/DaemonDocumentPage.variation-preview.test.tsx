/**
 * ADR-0022's later increment: a non-default variation is ADDRESSABLE via
 * `?v=<name>` — a read-only preview of that variation's tip, without moving
 * HEAD (switching stays a shared act behind an explicit control). Decision 1
 * holds: the default variation is never decorated, so `?v=main` and a `?v=`
 * naming the current HEAD both strip back to the plain address.
 */

import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  writeCoreFacets,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  act,
  cleanup,
  fireEvent,
  type RenderOptions,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'

function render(ui: ReactElement, options?: RenderOptions & { search?: string }) {
  const { search = '', ...rest } = options ?? {}
  return rtlRender(<MemoryRouter initialEntries={[`/${search}`]}>{ui}</MemoryRouter>, rest)
}

vi.mock('../lib/daemon-api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/daemon-api-client.js')>()
  return {
    ...actual,
    listWorkspaces: vi.fn(),
    listDocuments: vi.fn(),
    createDocument: vi.fn(),
  }
})

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const mockListWorkspaces = vi.mocked(daemonApiClient.listWorkspaces)
const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)

function markdownSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, '# Live body on HEAD')
  writeCoreFacets(doc, { type: 'markdown' })
  writeDocumentKind(doc, 'markdown')
  return doc.export({ mode: 'snapshot' })
}

class FakeBackend implements DocumentBackend {
  handlers: DocumentBackendHandlers | null = null
  connect(handlers: DocumentBackendHandlers): void {
    this.handlers = handlers
    handlers.onConnected()
    handlers.onSnapshot(markdownSnapshot())
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

const BRANCHES_STATE = {
  head: 'main',
  branches: [
    { name: 'main', tipFrontiers: '', color: '#1971c2', createdAt: '2026-01-01T00:00:00Z' },
    { name: 'idea', tipFrontiers: 'dGlw', color: '#e8590c', createdAt: '2026-01-02T00:00:00Z' },
  ],
}

/** Records every request; answers branches, the branch document, and names. */
function stubDaemon(overrides?: { headState?: typeof BRANCHES_STATE }) {
  const requests: Array<{ url: string; method: string }> = []
  const state = overrides?.headState ?? BRANCHES_STATE
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      requests.push({ url, method })
      if (url.includes('/names')) {
        return new Response(JSON.stringify({ documents: { note: 'Note' }, pinned: [] }), {
          status: 200,
        })
      }
      if (url.endsWith('/branches/idea/document')) {
        return new Response(JSON.stringify({ kind: 'markdown', body: '# From the idea tip' }), {
          status: 200,
        })
      }
      if (url.endsWith('/branches')) {
        return new Response(JSON.stringify(state), { status: 200 })
      }
      if (url.endsWith('/head') && method === 'PUT') {
        return new Response(JSON.stringify({ head: 'idea', previousHead: 'main' }), {
          status: 200,
        })
      }
      return new Response('{}', { status: 404 })
    }),
  )
  return requests
}

function mountPage(search: string) {
  return render(
    <DaemonDocumentPage
      daemonBaseUrl={DAEMON_BASE_URL}
      workspaceId="w1"
      path="note"
      createBackend={() => new FakeBackend()}
    />,
    { container: document.body, search },
  )
}

describe('DaemonDocumentPage ?v= variation preview', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mockListWorkspaces.mockResolvedValue({ workspaces: [{ workspaceId: 'w1' }] })
    mockListDocuments.mockResolvedValue({
      documents: [{ path: 'note', id: 'id-note', updatedAt: '2026-01-01', kind: 'markdown' }],
    })
  })
  afterEach(() => {
    cleanup()
    window.localStorage.clear()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('shows the variation tip read-only with a banner, and never mounts the editor', async () => {
    stubDaemon()
    await act(async () => {
      mountPage('?v=idea')
    })
    await waitFor(() => expect(screen.getByTestId('variation-preview-banner')).toBeTruthy())
    // The preview draws the BRANCH tip, not the live HEAD body.
    await waitFor(() => expect(document.body.textContent).toContain('From the idea tip'))
    expect(screen.queryByTestId('markdown-source-wrap')).toBeNull()
    expect(document.body.textContent).not.toContain('Live body on HEAD')
  })

  it('switch control PUTs head — the shared act stays explicit — and leaves the preview', async () => {
    const requests = stubDaemon()
    await act(async () => {
      mountPage('?v=idea')
    })
    await waitFor(() => expect(screen.getByTestId('variation-preview-switch')).toBeTruthy())
    await act(async () => {
      fireEvent.click(screen.getByTestId('variation-preview-switch'))
    })
    await waitFor(() =>
      expect(requests.some((r) => r.method === 'PUT' && r.url.endsWith('/head'))).toBe(true),
    )
    await waitFor(() => expect(screen.queryByTestId('variation-preview-banner')).toBeNull())
  })

  it('offers the combine lead-in from the banner', async () => {
    stubDaemon()
    await act(async () => {
      mountPage('?v=idea')
    })
    await waitFor(() => expect(screen.getByTestId('variation-preview-merge')).toBeTruthy())
  })

  it('strips ?v naming the current HEAD (the plain address already means it)', async () => {
    stubDaemon()
    await act(async () => {
      mountPage('?v=main')
    })
    await waitFor(() => expect(screen.getByTestId('markdown-source-wrap')).toBeTruthy())
    expect(screen.queryByTestId('variation-preview-banner')).toBeNull()
  })

  it('strips ?v naming a non-default HEAD too (the plain address means whatever HEAD is)', async () => {
    stubDaemon({ headState: { ...BRANCHES_STATE, head: 'idea' } })
    await act(async () => {
      mountPage('?v=idea')
    })
    await waitFor(() => expect(screen.getByTestId('markdown-source-wrap')).toBeTruthy())
    expect(screen.queryByTestId('variation-preview-banner')).toBeNull()
  })

  it('strips ?v=main even while HEAD is elsewhere — the default is never decorated (decision 1)', async () => {
    const requests = stubDaemon({ headState: { ...BRANCHES_STATE, head: 'idea' } })
    await act(async () => {
      mountPage('?v=main')
    })
    await waitFor(() => expect(screen.getByTestId('markdown-source-wrap')).toBeTruthy())
    expect(screen.queryByTestId('variation-preview-banner')).toBeNull()
    // Stripped by decision 1, not by a failed read: the default's content
    // was never requested, and no "could not be read" notice appears.
    expect(requests.some((r) => r.url.includes('/branches/main/document'))).toBe(false)
    expect(screen.queryByTestId('variation-preview-notice')).toBeNull()
  })

  it('falls back to the live document with a notice for an unknown variation', async () => {
    stubDaemon()
    await act(async () => {
      mountPage('?v=nope')
    })
    await waitFor(() => expect(screen.getByTestId('markdown-source-wrap')).toBeTruthy())
    await waitFor(() =>
      expect(screen.getByTestId('variation-preview-notice').textContent).toMatch(/not found/i),
    )
    expect(screen.queryByTestId('variation-preview-banner')).toBeNull()
  })
})
