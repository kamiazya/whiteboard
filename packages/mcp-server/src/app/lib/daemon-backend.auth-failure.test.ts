// @vitest-environment node
/**
 * Regression coverage: DaemonBackend must stop retrying when the server
 * closes the WebSocket with code 1008 (Policy Violation / auth failure).
 * Transient codes (1001, 1006, etc.) must still trigger the normal backoff reconnect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonBackend } from './daemon-backend.js'
import type { CanvasBackendHandlers } from './canvas-backend.js'

interface FakeCloseEvent extends Event {
  code: number
}

interface WsHandlers {
  onopen: ((event: Event) => void) | null
  onclose: ((event: FakeCloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
}

class FakeWebSocket implements WsHandlers {
  static instances: FakeWebSocket[] = []
  static CONNECTING = 0 as const
  static OPEN = 1 as const
  static CLOSING = 2 as const
  static CLOSED = 3 as const

  binaryType: BinaryType = 'blob'
  readyState: number = FakeWebSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: FakeCloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED
    const ev = Object.assign(new Event('close'), { code: 1000 }) as FakeCloseEvent
    this.onclose?.(ev)
  })

  constructor(_url: string | URL, _protocols?: string | string[]) {
    FakeWebSocket.instances.push(this)
  }
}

function makeHandlers(overrides?: Partial<CanvasBackendHandlers>): CanvasBackendHandlers {
  return {
    onSnapshot: vi.fn(),
    onRemoteUpdate: vi.fn(),
    onVersionCreated: vi.fn(),
    onRestoreStarted: vi.fn(),
    onRestoreComplete: vi.fn(),
    onHeadChanged: vi.fn(),
    onViewportRequest: vi.fn(),
    onExportRequest: vi.fn(),
    onConnected: vi.fn(),
    ...overrides,
  }
}

function simulateClose(ws: FakeWebSocket, code: number): void {
  ws.readyState = FakeWebSocket.CLOSED
  const ev = Object.assign(new Event('close'), { code }) as FakeCloseEvent
  ws.onclose?.(ev)
}

describe('DaemonBackend – auth failure (close code 1008)', () => {
  let originalWebSocket: unknown
  let originalWindow: unknown

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    originalWebSocket = (globalThis as Record<string, unknown>).WebSocket
    // DaemonBackend reads window.__WHITEBOARD_RUNTIME_CONFIG__; stub it.
    originalWindow = (globalThis as Record<string, unknown>).window
    ;(globalThis as Record<string, unknown>).window = {
      __WHITEBOARD_RUNTIME_CONFIG__: { daemonToken: null },
    }
    ;(globalThis as Record<string, unknown>).WebSocket = FakeWebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    ;(globalThis as Record<string, unknown>).WebSocket = originalWebSocket
    ;(globalThis as Record<string, unknown>).window = originalWindow
  })

  it('does NOT reconnect on close code 1008', async () => {
    const backend = new DaemonBackend('ws-id', 'test-canvas', 'http://localhost')
    const handlers = makeHandlers()
    backend.connect(handlers)

    expect(FakeWebSocket.instances).toHaveLength(1)

    simulateClose(FakeWebSocket.instances[0], 1008)

    // Advance far beyond the longest backoff to confirm no reconnect occurs.
    await vi.advanceTimersByTimeAsync(10_000)

    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('calls onAuthError when close code is 1008', async () => {
    const onAuthError = vi.fn()
    const backend = new DaemonBackend('ws-id', 'test-canvas', 'http://localhost')
    const handlers = makeHandlers({ onAuthError })
    backend.connect(handlers)

    simulateClose(FakeWebSocket.instances[0], 1008)

    await vi.advanceTimersByTimeAsync(100)

    expect(onAuthError).toHaveBeenCalledTimes(1)
  })

  it('still reconnects on transient close code 1006', async () => {
    const backend = new DaemonBackend('ws-id', 'test-canvas', 'http://localhost')
    const handlers = makeHandlers()
    backend.connect(handlers)

    expect(FakeWebSocket.instances).toHaveLength(1)

    simulateClose(FakeWebSocket.instances[0], 1006)

    await vi.advanceTimersByTimeAsync(500)

    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('still reconnects on transient close code 1001', async () => {
    const backend = new DaemonBackend('ws-id', 'test-canvas', 'http://localhost')
    const handlers = makeHandlers()
    backend.connect(handlers)

    simulateClose(FakeWebSocket.instances[0], 1001)

    await vi.advanceTimersByTimeAsync(500)

    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})
