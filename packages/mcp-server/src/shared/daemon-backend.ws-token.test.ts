// @vitest-environment node
//
// WS credential selection for a paired session. The server accepts an
// origin-scoped pairing session token through the same `daemon-token.`
// subprotocol carrier as the shared daemon token (ws-auth.ts), but the
// client used to offer ONLY the bootstrap global (`#wb=` flow) — a
// pairing-grant session therefore opened the socket with no credential at
// all and was rejected 401, silently losing every edit. These tests pin
// that the transport's wsToken reaches the upgrade offer.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTokenStoreForTests } from './token-store.js'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: (() => void) | null = null
  readonly url: string
  readonly protocols: string | string[] | undefined

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url)
    this.protocols = protocols
    FakeWebSocket.instances.push(this)
  }

  close(): void {
    /* no-op */
  }
}

const HANDLERS = {
  onSnapshot: () => {},
  onRemoteUpdate: () => {},
  onVersionCreated: () => {},
  onRestoreStarted: () => {},
  onRestoreComplete: () => {},
  onHeadChanged: () => {},
  onViewportRequest: () => {},
  onExportRequest: () => {},
  onConnected: () => {},
}

describe('DaemonBackend WS credential selection', () => {
  let originalWindow: unknown
  let originalWebSocket: unknown

  beforeEach(() => {
    FakeWebSocket.instances = []
    resetTokenStoreForTests()
    originalWindow = (globalThis as Record<string, unknown>).window
    originalWebSocket = (globalThis as Record<string, unknown>).WebSocket
    ;(globalThis as Record<string, unknown>).window = {
      location: { origin: 'http://localhost' },
    }
    ;(globalThis as Record<string, unknown>).WebSocket = FakeWebSocket
  })

  afterEach(() => {
    ;(globalThis as Record<string, unknown>).window = originalWindow
    ;(globalThis as Record<string, unknown>).WebSocket = originalWebSocket
    resetTokenStoreForTests()
  })

  it('offers the transport wsToken via the daemon-token subprotocol when no bootstrap global is seeded', async () => {
    const { DaemonBackend } = await import('./daemon-backend.js')
    const backend = new DaemonBackend('ws1', 'main', 'http://127.0.0.1:3099/', {
      fetch: globalThis.fetch,
      wsToken: () => 'pairing-session-token',
    })
    backend.connect(HANDLERS)
    expect(FakeWebSocket.instances[0]?.protocols).toEqual([
      'excalidraw-v1',
      'daemon-token.pairing-session-token',
    ])
  })

  it('prefers the bootstrap global over the transport wsToken when both exist', async () => {
    ;(globalThis as { window?: Record<string, unknown> }).window = {
      location: { origin: 'http://localhost' },
      __WHITEBOARD_DAEMON_TOKEN__: 'bootstrap-token',
    }
    const { DaemonBackend } = await import('./daemon-backend.js')
    const backend = new DaemonBackend('ws1', 'main', 'http://127.0.0.1:3099/', {
      fetch: globalThis.fetch,
      wsToken: () => 'pairing-session-token',
    })
    backend.connect(HANDLERS)
    expect(FakeWebSocket.instances[0]?.protocols).toEqual([
      'excalidraw-v1',
      'daemon-token.bootstrap-token',
    ])
  })

  it('re-reads a rotated wsToken on every socket attempt', async () => {
    const { DaemonBackend } = await import('./daemon-backend.js')
    let current = 'first-token'
    const backend = new DaemonBackend('ws1', 'main', 'http://127.0.0.1:3099/', {
      fetch: globalThis.fetch,
      wsToken: () => current,
    })
    backend.connect(HANDLERS)
    current = 'rotated-token'
    backend.disconnect()
    backend.connect(HANDLERS)
    expect(FakeWebSocket.instances[1]?.protocols).toEqual([
      'excalidraw-v1',
      'daemon-token.rotated-token',
    ])
  })

  it('keeps the credential-less offer when neither source provides a token', async () => {
    const { DaemonBackend } = await import('./daemon-backend.js')
    const backend = new DaemonBackend('ws1', 'main', 'http://127.0.0.1:3099/', {
      fetch: globalThis.fetch,
    })
    backend.connect(HANDLERS)
    expect(FakeWebSocket.instances[0]?.protocols).toEqual(['excalidraw-v1'])
  })
})
