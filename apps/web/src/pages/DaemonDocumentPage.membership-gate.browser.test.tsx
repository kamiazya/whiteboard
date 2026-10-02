// The web app's answer to a keeper's membership gate (ADR-0041/0042 S8): a
// not_a_member refusal lands on S5's removed page, and a
// requires_person_session refusal is an ordinary load error — no passkey in
// this browser can bind a session (ADR-0050 decision 3). Over a REAL fetch
// double (never a daemon-api-client mock), so the real DaemonApiError seam
// is what the classifier reads.

import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, screen } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { jsonResponse } from '../test-utils/json-response.js'
import '../index.css'
import { FakeDocumentBackend, renderPage } from '../test-utils/daemon-page-harness.js'

vi.mock('../lib/replica-refresh.js', async () =>
  (await import('../test-utils/daemon-page-harness.js')).replicaRefreshMock(),
)

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'
const WORKSPACE_ID = 'w1'

function seededSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'spatial')
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 100, y: 100, width: 200, height: 100, text: 'hello' })],
    edges: [],
  })
  return doc.export({ mode: 'snapshot' })
}

function pathOf(input: Request | string | URL): string {
  const url = input instanceof Request ? input.url : String(input)
  return new URL(url, DAEMON_BASE_URL).pathname
}

/**
 * A fetch double answering the real daemon routes this page's resolve
 * touches, with `/documents` behaving per `refuse` — `null` means it always
 * succeeds. Every unrelated route (backlinks, fonts, tags) answers a benign
 * 404, the same fallback the sibling composition browser tests use.
 */
function daemonFetchDouble(refuse: 'requires_person_session' | 'not_a_member') {
  const sentPaths: string[] = []
  const fetchDouble = (async (input: Request | string | URL) => {
    const path = pathOf(input)
    sentPaths.push(path)
    if (path === '/api/workspaces') {
      return jsonResponse({ workspaces: [{ workspaceId: WORKSPACE_ID }] })
    }
    if (path === `/api/workspaces/${WORKSPACE_ID}/documents`) {
      return refuse === 'not_a_member'
        ? jsonResponse({ error: 'not_a_member', message: 'removed from this workspace' }, 403)
        : jsonResponse(
            { error: 'requires_person_session', message: 'this session is not bound' },
            403,
          )
    }
    return jsonResponse({}, 404)
  }) as typeof fetch
  return { fetchDouble, sentPaths }
}

const credentialsGet = vi.fn(async () => null)

beforeEach(() => {
  credentialsGet.mockClear()
  Object.defineProperty(navigator, 'credentials', {
    value: { create: async () => null, get: credentialsGet },
    configurable: true,
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the daemon page answers a requires_person_session refusal', () => {
  it('reports the refusal as a load error and asks no passkey', async () => {
    const { fetchDouble, sentPaths } = daemonFetchDouble('requires_person_session')
    vi.stubGlobal('fetch', fetchDouble)

    renderPage(
      <DaemonDocumentPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspaceId={WORKSPACE_ID}
        path="board"
        createBackend={() => new FakeDocumentBackend(seededSnapshot)}
      />,
    )

    await expect.poll(() => document.body.textContent).toContain('this session is not bound')
    expect(screen.queryByTestId('spatial-editor')).toBeNull()
    expect(credentialsGet).not.toHaveBeenCalled()
    expect(sentPaths.some((p) => p.includes('/pairing/'))).toBe(false)
  })
})

describe('the daemon page answers a not_a_member refusal', () => {
  it('mounts the removed page and sends nothing after the refusal', async () => {
    const { fetchDouble, sentPaths } = daemonFetchDouble('not_a_member')
    vi.stubGlobal('fetch', fetchDouble)

    renderPage(
      <DaemonDocumentPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspaceId={WORKSPACE_ID}
        path="board"
        createBackend={() => new FakeDocumentBackend(seededSnapshot)}
      />,
    )

    const removed = await screen.findByTestId('replica-state-removed')
    expect(removed.textContent).toContain(
      'removed from this workspace; changes made since then were not sent',
    )
    expect(screen.queryByTestId('spatial-editor')).toBeNull()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    const status = await screen.findByTestId('replica-live-status')
    expect(status.textContent).toContain('removed from this workspace')

    await page.screenshot({ path: '../../../../tmp/screenshots/s8c/removed.png' })
    expect(sentPaths.some((p) => p.includes('/pairing/'))).toBe(false)
  })
})
