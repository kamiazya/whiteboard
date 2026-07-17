// @vitest-environment node
//
// The server closes a WS with 1003 (Unsupported Data) when a binary frame
// cannot be decoded as a Loro update (see server/routes/ws.ts). Replaying
// the same payload would always reproduce the same close, so — like 1008
// (Policy Violation) — the client must treat it as terminal rather than
// entering its exponential-backoff reconnect loop.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

describe('DaemonBackend close-code policy', () => {
  let originalWindow: unknown
  let originalWebSocket: unknown
  let originalSetTimeout: typeof setTimeout

  beforeEach(() => {
    FakeWebSocket.instances = []
    originalWindow = (globalThis as Record<string, unknown>).window
    originalWebSocket = (globalThis as Record<string, unknown>).WebSocket
    originalSetTimeout = globalThis.setTimeout
    ;(globalThis as Record<string, unknown>).window = {
      location: { origin: 'http://localhost' },
    }
    ;(globalThis as Record<string, unknown>).WebSocket = FakeWebSocket
  })

  afterEach(() => {
    ;(globalThis as Record<string, unknown>).window = originalWindow
    ;(globalThis as Record<string, unknown>).WebSocket = originalWebSocket
    globalThis.setTimeout = originalSetTimeout
  })

  it('treats close code 1003 as terminal: no reconnect timer scheduled, onAuthError called', async () => {
    const { DaemonBackend } = await import('./daemon-backend.js')
    const backend = new DaemonBackend('ws-id', 'slug', 'http://localhost/')
    const onAuthError = () => {
      authErrorCalled = true
    }
    let authErrorCalled = false
    const setTimeoutSpy = (): never => {
      throw new Error('reconnect must not be scheduled for a terminal close')
    }
    globalThis.setTimeout = setTimeoutSpy as unknown as typeof setTimeout

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
      onAuthError,
    })

    FakeWebSocket.instances[0]?.onclose?.({ code: 1003 })

    expect(authErrorCalled).toBe(true)
    backend.disconnect()
  })

  it('code 1006 still reconnects with backoff (unchanged behavior)', async () => {
    const { DaemonBackend } = await import('./daemon-backend.js')
    const backend = new DaemonBackend('ws-id', 'slug', 'http://localhost/')
    let scheduledDelay: number | null = null
    const setTimeoutSpy = ((fn: () => void, delay: number) => {
      scheduledDelay = delay
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
    globalThis.setTimeout = setTimeoutSpy

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

    FakeWebSocket.instances[0]?.onclose?.({ code: 1006 })

    expect(scheduledDelay).toBe(500)
    backend.disconnect()
  })
})
