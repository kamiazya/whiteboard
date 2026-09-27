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
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.OPEN
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

// A push is the session's only evidence that an edit left the tab. One the
// socket could not carry must say so: returning quietly read as "saved" for
// an edit that exists nowhere but this tab, while the reconnect's full re-send
// is what actually delivers it.
it('refuses a push while its socket is not open, instead of dropping it quietly', async () => {
  const backend = new DaemonBackend('ws-id', 'path', 'http://localhost/', {
    fetch: vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
  })
  backend.connect(handlers(vi.fn()))
  const socket = FakeWebSocket.instances[0] as FakeWebSocket & { readyState: number }

  socket.readyState = 3 // CLOSED, before its close event has been dispatched
  await expect(async () => backend.pushLocalUpdate(new Uint8Array([1]))).rejects.toThrow()
  backend.disconnect()
})

it('keeps reconnecting when the daemon answers the probe with a server error', async () => {
  const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 500 })))
  const backend = new DaemonBackend('ws-id', 'path', 'http://localhost/', { fetch })
  const onAuthError = vi.fn()
  backend.connect(handlers(onAuthError))

  await refuseSockets(3)

  expect(onAuthError).not.toHaveBeenCalled()
  expect(FakeWebSocket.instances.length).toBeGreaterThan(3)
  backend.disconnect()
})

it('keeps reconnecting when the probe never answers', async () => {
  const fetch = vi.fn(
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('timeout', 'TimeoutError')),
        )
      }),
  )
  const backend = new DaemonBackend('ws-id', 'path', 'http://localhost/', {
    fetch: fetch as unknown as typeof globalThis.fetch,
  })
  const onAuthError = vi.fn()
  backend.connect(handlers(onAuthError))

  await refuseSockets(3)
  await vi.advanceTimersByTimeAsync(30_000)

  expect(onAuthError).not.toHaveBeenCalled()
  expect(FakeWebSocket.instances.length).toBeGreaterThan(3)
  backend.disconnect()
})
