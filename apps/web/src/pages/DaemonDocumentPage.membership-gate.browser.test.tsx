// The web app's answer to the daemon's online membership gate (ADR-0041/0042
// S8 slice 3): a requires_person_session refusal binds the passkey once and
// retries, and a not_a_member refusal lands on S5's removed page — over a
// REAL fetch double (never a daemon-api-client mock), so the real
// DaemonApiError seam is what the classifier reads.

import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render as rtlRender, screen } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '../index.css'
import type { PasskeyCredentials } from '../lib/passkey-attestation.js'

vi.mock('../lib/replica-refresh.js', () => ({
  scheduleReplicaRefresh: vi.fn(),
  scheduleReplicaPush: vi.fn(),
}))

const { DaemonDocumentPage } = await import('./DaemonDocumentPage.js')

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'
const WORKSPACE_ID = 'w1'
const PASSKEYS_KEY = 'whiteboard:daemon-passkeys'

function render(ui: ReactElement) {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

function seededSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'spatial')
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id: 'n1', x: 100, y: 100, width: 200, height: 100, text: 'hello' })],
    edges: [],
  })
  return doc.export({ mode: 'snapshot' })
}

class FakeBackend implements DocumentBackend {
  handlers: DocumentBackendHandlers | null = null
  connect(handlers: DocumentBackendHandlers): void {
    this.handlers = handlers
    handlers.onConnected()
    handlers.onSnapshot(seededSnapshot())
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

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

const RAW_ID = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
const CHALLENGE_B64U = b64u(Uint8Array.from({ length: 32 }, (_, i) => i))

function assertionCredential(): Credential {
  return {
    id: b64u(RAW_ID),
    type: 'public-key',
    rawId: RAW_ID.buffer,
    response: {
      authenticatorData: Uint8Array.from({ length: 37 }, (_, i) => 37 - i).buffer,
      clientDataJSON: new TextEncoder().encode('{"type":"webauthn.get"}').buffer,
      signature: Uint8Array.from([70, 71, 72]).buffer,
    },
  } as unknown as Credential
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
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
function daemonFetchDouble(refuse: 'requires_person_session' | 'not_a_member' | null) {
  const sentPaths: string[] = []
  let sessionAsserted = false
  const fetchDouble = (async (input: Request | string | URL) => {
    const path = pathOf(input)
    sentPaths.push(path)
    if (path === '/api/workspaces') {
      return jsonResponse({ workspaces: [{ workspaceId: WORKSPACE_ID }] })
    }
    if (path === `/api/workspaces/${WORKSPACE_ID}/documents`) {
      if (refuse === 'not_a_member') {
        return jsonResponse({ error: 'not_a_member', message: 'removed from this workspace' }, 403)
      }
      if (refuse === 'requires_person_session' && !sessionAsserted) {
        return jsonResponse(
          { error: 'requires_person_session', message: 'this session is not bound' },
          403,
        )
      }
      return jsonResponse({
        documents: [{ path: 'board', id: 'id-board', updatedAt: '2026-01-01', kind: 'spatial' }],
      })
    }
    if (path === '/api/pairing/session-assert/challenge') {
      return jsonResponse({ challenge: CHALLENGE_B64U, expiresAt: '2026-01-01T00:00:00.000Z' })
    }
    if (path === '/api/pairing/session-assert') {
      sessionAsserted = true
      return jsonResponse({
        credentialId: b64u(RAW_ID),
        profileId: null,
        boundUntil: '2026-01-01T01:00:00.000Z',
      })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return { fetchDouble, sentPaths }
}

function seedRegisteredPasskey() {
  localStorage.setItem(
    PASSKEYS_KEY,
    JSON.stringify({ [DAEMON_BASE_URL]: { credentialId: b64u(RAW_ID), registeredAt: 'x' } }),
  )
}

beforeEach(() => {
  vi.stubGlobal('PublicKeyCredential', class {})
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.removeItem(PASSKEYS_KEY)
})

describe('the daemon page answers a requires_person_session refusal', () => {
  it('binds the passkey once (one credentials.get) and the document loads', async () => {
    seedRegisteredPasskey()
    let getCalls = 0
    const credentials: PasskeyCredentials = {
      create: async () => null,
      get: async () => {
        getCalls += 1
        return assertionCredential()
      },
    }
    Object.defineProperty(navigator, 'credentials', { value: credentials, configurable: true })
    const { fetchDouble } = daemonFetchDouble('requires_person_session')
    vi.stubGlobal('fetch', fetchDouble)

    render(
      <DaemonDocumentPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspaceId={WORKSPACE_ID}
        path="board"
        createBackend={() => new FakeBackend()}
      />,
    )

    await screen.findByTestId('spatial-editor', undefined, { timeout: 15_000 })
    expect(getCalls).toBe(1)
  })
})

describe('the daemon page answers a not_a_member refusal', () => {
  it('mounts the removed page and sends nothing after the refusal', async () => {
    const credentials: PasskeyCredentials = { create: async () => null, get: async () => null }
    Object.defineProperty(navigator, 'credentials', { value: credentials, configurable: true })
    const { fetchDouble, sentPaths } = daemonFetchDouble('not_a_member')
    vi.stubGlobal('fetch', fetchDouble)

    render(
      <DaemonDocumentPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspaceId={WORKSPACE_ID}
        path="board"
        createBackend={() => new FakeBackend()}
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
    expect(sentPaths.some((p) => p.includes('/session-assert'))).toBe(false)
  })
})

describe('the daemon page answers a cancelled passkey prompt', () => {
  it('shows the passkey-needed status, and Try again re-resolves once the daemon admits the session', async () => {
    seedRegisteredPasskey()
    let getCalls = 0
    let shouldCancel = true
    const credentials: PasskeyCredentials = {
      create: async () => null,
      get: async () => {
        getCalls += 1
        if (shouldCancel) throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })
        return assertionCredential()
      },
    }
    Object.defineProperty(navigator, 'credentials', { value: credentials, configurable: true })
    const { fetchDouble } = daemonFetchDouble('requires_person_session')
    vi.stubGlobal('fetch', fetchDouble)

    render(
      <DaemonDocumentPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspaceId={WORKSPACE_ID}
        path="board"
        createBackend={() => new FakeBackend()}
      />,
    )

    // The DaemonTerminalScreen status paragraph is mounted from FIRST paint
    // (empty during the loading skeleton), captured here before the passkey
    // prompt has even resolved — proves it is not a fresh node born with
    // the message (polite-live-region.test.ts).
    const liveStatus = screen.getByTestId('daemon-live-status')
    expect(liveStatus.getAttribute('role')).toBe('status')
    expect(liveStatus.textContent).toBe('')

    await expect
      .poll(() => liveStatus.textContent)
      .toContain('This workspace only opens for its members')
    // Same DOM node — its text changed in place, it was never remounted.
    expect(screen.getByTestId('daemon-live-status')).toBe(liveStatus)
    const retry = await screen.findByRole('button', { name: 'Try again' })

    await page.screenshot({ path: '../../../../tmp/screenshots/s8c/passkey-needed.png' })

    expect(getCalls).toBe(1)
    shouldCancel = false
    retry.focus()
    await userEvent.keyboard('{Enter}')

    await screen.findByTestId('spatial-editor', undefined, { timeout: 15_000 })
    expect(getCalls).toBe(2)
  })
})
