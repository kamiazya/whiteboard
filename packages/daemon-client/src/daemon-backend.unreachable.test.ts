// @vitest-environment node
//
// A socket that never opens, three times running, was read as "this token
// can never succeed", and the backend stopped reconnecting. A daemon that is
// simply NOT RUNNING looks the same from the socket (1006, never opened), so
// a restart left every open page on "Live sync off" for good. An HTTP request
// tells them apart: a stopped daemon fails at the network, while one that
// refuses the credential still answers.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DaemonBackend } from './daemon-backend.js'
import type { DocumentBackendHandlers } from './document-backend-contract.js'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: (() => void) | null = null
  constructor(readonly url: string | URL) {
    FakeWebSocket.instances.push(this)
  }
  close(): void {}
}

const originals: Record<string, unknown> = {}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
  const g = globalThis as Record<string, unknown>
  originals.window = g.window
  originals.WebSocket = g.WebSocket
  g.window = { location: { origin: 'http://localhost' } }
  g.WebSocket = FakeWebSocket
})

afterEach(() => {
  const g = globalThis as Record<string, unknown>
  g.window = originals.window
  g.WebSocket = originals.WebSocket
  vi.useRealTimers()
})

function handlers(onAuthError: () => void): DocumentBackendHandlers {
  return {
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
  }
}

/** Closes each socket before it opens, the way a refused connection does. */
async function refuseSockets(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const socket = FakeWebSocket.instances.at(-1)
    socket?.onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(10_000)
  }
}

it('keeps reconnecting while the daemon does not answer at all', async () => {
  const fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
  const backend = new DaemonBackend('ws-id', 'path', 'http://localhost/', { fetch })
  const onAuthError = vi.fn()
  backend.connect(handlers(onAuthError))

  await refuseSockets(6)

  expect(onAuthError).not.toHaveBeenCalled()
  expect(fetch).toHaveBeenCalled()
  expect(FakeWebSocket.instances.length).toBeGreaterThan(6)
  backend.disconnect()
})

it('still gives up when the daemon answers but the socket keeps being refused', async () => {
  const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 401 })))
  const backend = new DaemonBackend('ws-id', 'path', 'http://localhost/', { fetch })
  const onAuthError = vi.fn()
  backend.connect(handlers(onAuthError))

  await refuseSockets(3)

  expect(onAuthError).toHaveBeenCalledTimes(1)
  const opened = FakeWebSocket.instances.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(FakeWebSocket.instances.length).toBe(opened)
  backend.disconnect()
})
