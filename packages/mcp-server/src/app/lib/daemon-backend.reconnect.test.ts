/**
 * Focused unit tests for DaemonBackend WebSocket reconnect and backoff logic.
 *
 * Tests here assert the reconnect state machine independent of message routing
 * or file-IO concerns. A mocked WebSocket and vi.useFakeTimers() keep the
 * suite deterministic with no real network or clock dependency.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// DaemonBackend now lives in src/shared/daemon-backend.ts, so its
// api-client/upload-files imports resolve to src/shared/*, not the
// src/app/lib re-export shims.
const apiFetchMock = vi.fn()
vi.mock('../../shared/api-client.js', () => ({
  apiFetch: apiFetchMock,
}))

const readDaemonTokenOnceMock = vi.fn(() => null)
vi.mock('../../shared/token-store.js', () => ({
  readDaemonTokenOnce: readDaemonTokenOnceMock,
}))

const uploadFilesMock = vi.fn()
vi.mock('../../shared/upload-files.js', () => ({ uploadFiles: uploadFilesMock }))

const { DaemonBackend } = await import('./daemon-backend.js')

// ── FakeWebSocket ────────────────────────────────────────────────────────────

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static CONNECTING = 0 as const
  static OPEN = 1 as const
  static CLOSING = 2 as const
  static CLOSED = 3 as const

  binaryType: BinaryType = 'blob'
  readyState: number = FakeWebSocket.CONNECTING
  url: string
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.(new Event('close') as CloseEvent)
  })

  constructor(url: string | URL, _protocols?: string | string[]) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }
}

type Handlers = Parameters<InstanceType<typeof DaemonBackend>['connect']>[0]

function makeHandlers(overrides: Partial<Handlers> = {}): Handlers {
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

function makeBackend(): InstanceType<typeof DaemonBackend> {
  return new DaemonBackend('ws-sid', 'slug', 'http://localhost/')
}

function lastSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
}

function triggerClose(socket: FakeWebSocket): void {
  socket.onclose?.(new Event('close') as CloseEvent)
}

function deliverFrame(socket: FakeWebSocket, byte: number): void {
  socket.onmessage?.(new MessageEvent('message', { data: new Uint8Array([byte]).buffer }))
}

function deliverText(socket: FakeWebSocket, payload: unknown): void {
  socket.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }))
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

let originalWebSocket: typeof WebSocket

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
  originalWebSocket = globalThis.WebSocket
  Object.defineProperty(globalThis, 'WebSocket', {
    value: FakeWebSocket,
    writable: true,
    configurable: true,
  })
  // Supply a minimal window shim where jsdom does not define it.
  if (typeof window === 'undefined' || !window.location) {
    Object.defineProperty(globalThis, 'window', {
      value: {
        location: { href: 'http://localhost/', origin: 'http://localhost' },
        __WHITEBOARD_RUNTIME_CONFIG__: null,
      },
      writable: true,
      configurable: true,
    })
  }
})

afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(globalThis, 'WebSocket', {
    value: originalWebSocket,
    writable: true,
    configurable: true,
  })
})

// ── Exponential backoff sequence ─────────────────────────────────────────────

describe('exponential backoff delay sequence', () => {
  it('fires 500ms after the first close (attempt 0)', async () => {
    const backend = makeBackend()
    backend.connect(makeHandlers())

    triggerClose(FakeWebSocket.instances[0])
    expect(FakeWebSocket.instances).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(499)
    expect(FakeWebSocket.instances).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(2)

    backend.disconnect()
  })

  it('follows the 500 / 1000 exponential growth up to the never-opened failure cap', async () => {
    // Only 2 delays are assertable here: the 3rd consecutive close of a socket
    // that never opened trips MAX_CONSECUTIVE_IMMEDIATE_FAILURES (see the
    // "never-opened failure cap" describe block below), which stops
    // reconnecting instead of scheduling a 3rd backoff delay.
    const backend = makeBackend()
    backend.connect(makeHandlers())

    const expectedDelays = [500, 1000]

    for (const delay of expectedDelays) {
      const countBefore = FakeWebSocket.instances.length
      triggerClose(lastSocket())

      // One millisecond short — must not have reconnected yet.
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(FakeWebSocket.instances).toHaveLength(countBefore)

      // Exactly on time — reconnect must have fired.
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeWebSocket.instances).toHaveLength(countBefore + 1)
    }

    backend.disconnect()
  })

  it('keeps reconnecting at the base 500ms delay across many opened-then-dropped cycles', async () => {
    // onopen already resets `attempt` to 0 (see the "resets the attempt
    // counter" test below), so a connection that opens successfully every
    // time before dropping restarts backoff at 500ms each cycle. The
    // never-opened failure counter must also reset on every open, so this
    // must keep reconnecting indefinitely rather than tripping the
    // auth-failure cap regardless of how many cycles occur.
    const backend = makeBackend()
    backend.connect(makeHandlers())

    for (let cycle = 0; cycle < 6; cycle++) {
      const countBefore = FakeWebSocket.instances.length
      const socket = lastSocket()
      socket.onopen?.(new Event('open'))
      triggerClose(socket)

      await vi.advanceTimersByTimeAsync(499)
      expect(FakeWebSocket.instances).toHaveLength(countBefore)

      await vi.advanceTimersByTimeAsync(1)
      expect(FakeWebSocket.instances).toHaveLength(countBefore + 1)
    }

    backend.disconnect()
  })

  it('resets the attempt counter to 0 after onopen, so the next close starts at 500ms again', async () => {
    const backend = makeBackend()
    backend.connect(makeHandlers())

    // First close: attempt=0 → 500ms.
    triggerClose(FakeWebSocket.instances[0])
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(2)

    // Second close without open: attempt=1 → 1000ms.
    triggerClose(FakeWebSocket.instances[1])
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeWebSocket.instances).toHaveLength(2) // not yet
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(3)

    // onopen resets attempt to 0; next close must be 500ms again.
    FakeWebSocket.instances[2].onopen?.(new Event('open'))
    triggerClose(FakeWebSocket.instances[2])
    await vi.advanceTimersByTimeAsync(499)
    expect(FakeWebSocket.instances).toHaveLength(3) // not yet
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(4)

    backend.disconnect()
  })
})

// ── snapshotReceived state machine ───────────────────────────────────────────

describe('snapshotReceived state machine', () => {
  it('does NOT reset snapshotReceived on automatic reconnect — first frame routes to onRemoteUpdate', async () => {
    // Replacing the LoroDoc on reconnect would destroy local unsynced edits
    // and UndoManager history. Reconnect merges (import) rather than replaces.
    const onSnapshot = vi.fn()
    const onRemoteUpdate = vi.fn()
    const backend = makeBackend()
    backend.connect(makeHandlers({ onSnapshot, onRemoteUpdate }))

    // Receive initial snapshot on first connection.
    deliverFrame(FakeWebSocket.instances[0], 1)
    expect(onSnapshot).toHaveBeenCalledTimes(1)
    expect(onRemoteUpdate).toHaveBeenCalledTimes(0)

    // Automatic reconnect (onclose without disconnect()).
    triggerClose(FakeWebSocket.instances[0])
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(2)

    // First frame on the new socket routes to onRemoteUpdate, not onSnapshot.
    deliverFrame(FakeWebSocket.instances[1], 2)
    expect(onSnapshot).toHaveBeenCalledTimes(1)
    expect(onRemoteUpdate).toHaveBeenCalledTimes(1)

    backend.disconnect()
  })

  it('resets snapshotReceived to false after disconnect(), so the next connect() re-snapshots', () => {
    const onSnapshot = vi.fn()
    const onRemoteUpdate = vi.fn()
    const backend = makeBackend()
    backend.connect(makeHandlers({ onSnapshot, onRemoteUpdate }))

    deliverFrame(FakeWebSocket.instances[0], 1)
    expect(onSnapshot).toHaveBeenCalledTimes(1)

    // Full disconnect resets snapshotReceived.
    backend.disconnect()
    backend.connect(makeHandlers({ onSnapshot, onRemoteUpdate }))

    deliverFrame(lastSocket(), 2)

    // First frame of the fresh connection is treated as a snapshot again.
    expect(onSnapshot).toHaveBeenCalledTimes(2)
    expect(onRemoteUpdate).not.toHaveBeenCalled()

    backend.disconnect()
  })
})

// ── onerror → force-close → reconnect ───────────────────────────────────────

describe('onerror triggers reconnect', () => {
  it('creates a new socket after onerror even when the browser omits the close event', async () => {
    // Some browsers fire onerror without a subsequent close event.
    // The onerror handler calls ws.close() to guarantee the onclose path runs,
    // which schedules the backoff timer and eventually opens a new socket.
    const backend = makeBackend()
    backend.connect(makeHandlers())

    const firstSocket = FakeWebSocket.instances[0]

    // Simulate an error without a close event following it.
    // FakeWebSocket.close() fires onclose, so call onerror directly and
    // then manually advance state without triggering onclose separately.
    firstSocket.onerror?.(new Event('error'))

    // onerror calls ws.close(), which on FakeWebSocket triggers onclose and
    // schedules the reconnect timer.
    expect(FakeWebSocket.instances).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(2)

    backend.disconnect()
  })
})

// ── binaryType invariant ──────────────────────────────────────────────────────

describe('binaryType invariant', () => {
  it('sets binaryType to arraybuffer on every newly created socket', async () => {
    // Without binaryType = 'arraybuffer', binary frames arrive as Blob and the
    // ArrayBuffer instanceof check in the message handler silently fails,
    // breaking snapshot and remote-update delivery.
    const backend = makeBackend()
    backend.connect(makeHandlers())

    expect(lastSocket().binaryType).toBe('arraybuffer')

    // Verify the invariant holds on a reconnected socket too.
    triggerClose(FakeWebSocket.instances[0])
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(2)

    expect(lastSocket().binaryType).toBe('arraybuffer')

    backend.disconnect()
  })
})

// ── disconnect() halts the reconnect loop ────────────────────────────────────

describe('disconnect() cancels the reconnect loop', () => {
  it('does not create a new socket after disconnect() cancels the pending timer', async () => {
    const backend = makeBackend()
    backend.connect(makeHandlers())

    // Trigger a close so a backoff timer is scheduled.
    triggerClose(FakeWebSocket.instances[0])
    expect(FakeWebSocket.instances).toHaveLength(1)

    // Cancel before the 500ms timer fires.
    backend.disconnect()

    await vi.advanceTimersByTimeAsync(1000)
    // The pending timer must have been cleared — no new socket.
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('does not reconnect if disconnect() is called while the initial socket is still connecting', async () => {
    const backend = makeBackend()
    backend.connect(makeHandlers())

    // Disconnect before the socket even opens.
    backend.disconnect()

    // Close the socket to simulate its eventual failure; no reconnect must follow.
    triggerClose(FakeWebSocket.instances[0])
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('closes the current WebSocket when disconnect() is called', () => {
    const backend = makeBackend()
    backend.connect(makeHandlers())
    const ws = FakeWebSocket.instances[0]
    backend.disconnect()
    expect(ws.close).toHaveBeenCalledTimes(1)
  })
})

// ── never-opened failure cap (WS auth-failure reconnect loop fix) ──────────
//
// A wrong/expired daemon token makes the WS handshake fail at the HTTP layer,
// which browsers surface as close code 1006 (not 1008), so the 1008-based
// onAuthError branch never fires and the backend reconnects forever. Track
// consecutive closes of sockets that never opened; after
// MAX_CONSECUTIVE_IMMEDIATE_FAILURES stop reconnecting and surface onAuthError
// instead, since retrying with the same rejected token cannot succeed.

describe('never-opened failure cap', () => {
  it('stops reconnecting and invokes onAuthError after 3 consecutive never-opened closes', async () => {
    const onAuthError = vi.fn()
    const backend = makeBackend()
    backend.connect(makeHandlers({ onAuthError }))

    // Failure 1: schedules a reconnect as usual.
    triggerClose(FakeWebSocket.instances[0])
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(onAuthError).not.toHaveBeenCalled()

    // Failure 2: still under the cap, keeps reconnecting.
    triggerClose(FakeWebSocket.instances[1])
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(3)
    expect(onAuthError).not.toHaveBeenCalled()

    // Failure 3 (never opened again): trips the cap — no new socket, onAuthError fires.
    triggerClose(FakeWebSocket.instances[2])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeWebSocket.instances).toHaveLength(3)
    expect(onAuthError).toHaveBeenCalledTimes(1)

    backend.disconnect()
  })

  it('keeps reconnecting for a single transient never-opened failure (does not trip the cap)', async () => {
    const onAuthError = vi.fn()
    const backend = makeBackend()
    backend.connect(makeHandlers({ onAuthError }))

    triggerClose(FakeWebSocket.instances[0])
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(onAuthError).not.toHaveBeenCalled()

    backend.disconnect()
  })

  it('resets the never-opened failure counter once a socket opens, so a later single blip does not trip the cap', async () => {
    const onAuthError = vi.fn()
    const backend = makeBackend()
    backend.connect(makeHandlers({ onAuthError }))

    // Two never-opened failures (one below the cap)...
    triggerClose(FakeWebSocket.instances[0])
    await vi.advanceTimersByTimeAsync(500)
    triggerClose(FakeWebSocket.instances[1])
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(3)

    // ...then a successful open resets the counter.
    FakeWebSocket.instances[2].onopen?.(new Event('open'))
    triggerClose(FakeWebSocket.instances[2])
    await vi.advanceTimersByTimeAsync(500)
    expect(FakeWebSocket.instances).toHaveLength(4)

    // A single subsequent never-opened failure must not trip the cap.
    triggerClose(FakeWebSocket.instances[3])
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(5)
    expect(onAuthError).not.toHaveBeenCalled()

    backend.disconnect()
  })

  it('code 1008 still triggers onAuthError immediately regardless of the never-opened counter', async () => {
    const onAuthError = vi.fn()
    const backend = makeBackend()
    backend.connect(makeHandlers({ onAuthError }))

    const closeEvent = { code: 1008 } as unknown as CloseEvent
    FakeWebSocket.instances[0].onclose?.(closeEvent)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(onAuthError).toHaveBeenCalled()

    backend.disconnect()
  })

  it('disconnect() during the never-opened failure window cancels the pending timer and never fires onAuthError afterwards', async () => {
    const onAuthError = vi.fn()
    const backend = makeBackend()
    backend.connect(makeHandlers({ onAuthError }))

    triggerClose(FakeWebSocket.instances[0])
    backend.disconnect()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(onAuthError).not.toHaveBeenCalled()
  })
})
