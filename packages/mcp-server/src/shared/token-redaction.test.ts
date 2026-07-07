// @vitest-environment node
//
// Regression guard: the daemon auth token must never surface in a log
// record while flowing through TokenStore -> apiFetch -> DaemonBackend.
// None of these modules call getLogger today, so this test is a tripwire —
// it fails the moment a future log call captures the token value anywhere
// in a record's message or structured fields.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { captureLogsForTests } from '../server/log.js'
import { readDaemonTokenOnce, resetTokenStoreForTests } from './token-store.js'

const SENTINEL_TOKEN = 'sentinel-do-not-log-9f3c2a'

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

function recordsContainSentinel(
  records: ReturnType<typeof captureLogsForTests>['records'],
): boolean {
  return records.some((record) => {
    const haystack = `${record.msg} ${JSON.stringify(record.data ?? {})}`
    return haystack.includes(SENTINEL_TOKEN)
  })
}

describe('token redaction: sentinel never reaches a log record', () => {
  let originalWindow: unknown
  let originalWebSocket: unknown
  let originalFetch: typeof fetch

  beforeEach(() => {
    resetTokenStoreForTests()
    originalWindow = (globalThis as Record<string, unknown>).window
    originalWebSocket = (globalThis as Record<string, unknown>).WebSocket
    originalFetch = globalThis.fetch
    ;(globalThis as Record<string, unknown>).window = {
      location: { origin: 'http://localhost' },
      __WHITEBOARD_DAEMON_TOKEN__: SENTINEL_TOKEN,
    }
    ;(globalThis as Record<string, unknown>).WebSocket = FakeWebSocket
    globalThis.fetch = (async () => new Response('ok')) as typeof fetch
  })

  afterEach(() => {
    ;(globalThis as Record<string, unknown>).window = originalWindow
    ;(globalThis as Record<string, unknown>).WebSocket = originalWebSocket
    globalThis.fetch = originalFetch
    resetTokenStoreForTests()
  })

  it('token-store read does not log the sentinel', () => {
    const capture = captureLogsForTests()
    try {
      readDaemonTokenOnce()
      expect(recordsContainSentinel(capture.records)).toBe(false)
    } finally {
      capture.restore()
    }
  })

  it('apiFetch auth-header attachment does not log the sentinel', async () => {
    const capture = captureLogsForTests()
    try {
      const { apiFetch } = await import('./api-client.js')
      await apiFetch('http://localhost/api/workspaces')
      expect(recordsContainSentinel(capture.records)).toBe(false)
    } finally {
      capture.restore()
    }
  })

  it('DaemonBackend.openSocket (incl. simulated auth failure) does not log the sentinel', async () => {
    const capture = captureLogsForTests()
    try {
      const { DaemonBackend } = await import('./daemon-backend.js')
      const backend = new DaemonBackend('ws-id', 'slug', 'http://localhost/')
      backend.connect({
        onSnapshot: () => {},
        onRemoteUpdate: () => {},
        onVersionCreated: () => {},
        onRestoreStarted: () => {},
        onRestoreComplete: () => {},
        onHeadChanged: () => {},
        onViewportRequest: () => {},
        onExportRequest: () => {},
        onConnected: () => {},
        onAuthError: () => {},
      })
      // Simulate the server rejecting the connection due to auth failure.
      FakeWebSocket.instances[0]?.onclose?.({ code: 1008 })
      backend.disconnect()
      expect(recordsContainSentinel(capture.records)).toBe(false)
    } finally {
      capture.restore()
    }
  })
})
