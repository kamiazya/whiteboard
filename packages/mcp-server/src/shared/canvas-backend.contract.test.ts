// @vitest-environment node
// The two transport backends against the shared CanvasBackend contract. The
// browser-local implementation runs the same cases from apps/web, where its
// store lives.
import { describe, vi } from 'vitest'
import { DaemonBackend } from './daemon-backend.js'
import { SseBackend } from './sse-backend.js'
import type { CanvasBackendHarness } from './test-utils/canvas-backend-contract.js'
import { canvasBackendContract } from './test-utils/canvas-backend-contract.js'

const BASE = 'http://127.0.0.1:3099'

/** Records what a backend POSTs upstream and serves the routes it reads. */
function createFetch(sent: Uint8Array[]) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/snapshot')) return new Response(new Uint8Array([1, 1, 1]), { status: 200 })
    if (url.includes('/update')) {
      const body = init?.body
      if (body instanceof ArrayBuffer) sent.push(new Uint8Array(body))
      return new Response('{}', { status: 200 })
    }
    if (url.includes('/api/sync/stream')) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `event: ready\ndata: ${JSON.stringify({ streamId: 'contract-stream' })}\n\n`,
              ),
            )
          },
        }),
        { status: 200 },
      )
    }
    // A file the canvas does not have. 404 is what the daemon answers.
    if (url.includes('/file/')) return new Response('not found', { status: 404 })
    return new Response('{}', { status: 200 })
  }) as unknown as typeof globalThis.fetch
}

describe('CanvasBackend contract: SseBackend', () => {
  canvasBackendContract((): CanvasBackendHarness => {
    const sent: Uint8Array[] = []
    const backend = new SseBackend('ws-1', 'canvas-a', BASE, { fetch: createFetch(sent) })
    return { backend, sentUpdates: () => sent, cleanup: () => backend.disconnect() }
  })
})

/**
 * A WebSocket stand-in. DaemonBackend constructs `new WebSocket(...)` itself
 * rather than taking a factory, and swapping the global is the seam its
 * existing reconnect test already uses — so this follows that rather than
 * opening a new injection point in production code for tests alone.
 */
class FakeWebSocket {
  static OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  binaryType = 'arraybuffer'
  readonly sent: unknown[] = []

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
    // The real socket opens on a later tick, which is what gives a disconnect
    // a window to land mid-connect.
    setTimeout(() => {
      // close() on a CONNECTING socket aborts the handshake: the browser fires
      // onclose and never onopen. Modelling that matters — a fake that opened
      // anyway would report a defect the real transport cannot have.
      if (this.readyState !== 1) return
      this.onopen?.()
      this.onmessage?.({ data: new Uint8Array([1, 1, 1]).buffer })
    }, 0)
  }

  send(data: unknown): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }
}

describe('CanvasBackend contract: DaemonBackend', () => {
  canvasBackendContract((): CanvasBackendHarness => {
    const sent: Uint8Array[] = []
    const realWs = globalThis.WebSocket
    FakeWebSocket.instances = []
    ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
    const backend = new DaemonBackend('ws-1', 'canvas-a', BASE, { fetch: createFetch(sent) })
    return {
      backend,
      // The socket is sent a Uint8Array view, not an ArrayBuffer.
      sentUpdates: () =>
        FakeWebSocket.instances.flatMap((ws) =>
          ws.sent.filter((d): d is Uint8Array => d instanceof Uint8Array),
        ),
      cleanup: () => {
        backend.disconnect()
        ;(globalThis as { WebSocket: unknown }).WebSocket = realWs
      },
    }
  })
})
