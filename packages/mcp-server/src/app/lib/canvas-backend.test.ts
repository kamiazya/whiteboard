/**
 * Nearest-layer tests for the CanvasBackend seam.
 * Pure-logic / contract tests that do not need real browser APIs.
 * Covers DaemonBackend wiring, backoff schedule, frame routing, and text dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stubs for modules that DaemonBackend imports.
const apiFetchMock = vi.fn()
vi.mock('./api-client.js', () => ({ apiFetch: apiFetchMock }))

const uploadFilesMock = vi.fn()
vi.mock('./upload-files.js', () => ({ uploadFiles: uploadFilesMock }))

// Import after mocks are hoisted.
const { DaemonBackend } = await import('./daemon-backend.js')

// ── FakeWebSocket ──────────────────────────────────────────────────────────────

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

function makeBackend(): InstanceType<typeof DaemonBackend> {
  return new DaemonBackend('ws-sid', 'slug', 'http://localhost/')
}

describe('DaemonBackend', () => {
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
    // jsdom does not define window.location so supply a minimal shim
    if (typeof window === 'undefined' || !window.location) {
      Object.defineProperty(globalThis, 'window', {
        value: { location: { href: 'http://localhost/', origin: 'http://localhost' }, __WHITEBOARD_RUNTIME_CONFIG__: null },
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

  function makeHandlers(overrides: Partial<Parameters<InstanceType<typeof DaemonBackend>['connect']>[0]> = {}): Parameters<InstanceType<typeof DaemonBackend>['connect']>[0] {
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

  describe('onerror force-close', () => {
    it('calls ws.close() when onerror fires', () => {
      const backend = makeBackend()
      backend.connect(makeHandlers())
      const ws = FakeWebSocket.instances[0]
      ws.onerror?.(new Event('error'))
      expect(ws.close).toHaveBeenCalledTimes(1)
      backend.disconnect()
    })

    it('triggers reconnect after onerror (via the subsequent onclose)', async () => {
      // FakeWebSocket.close() calls onclose automatically, so onerror → close()
      // → onclose → reconnect timer.
      const backend = makeBackend()
      backend.connect(makeHandlers())
      expect(FakeWebSocket.instances).toHaveLength(1)

      FakeWebSocket.instances[0].onerror?.(new Event('error'))
      await vi.advanceTimersByTimeAsync(500)

      expect(FakeWebSocket.instances).toHaveLength(2)
      backend.disconnect()
    })
  })

  describe('connection lifecycle', () => {
    it('creates one WebSocket on connect()', () => {
      const backend = makeBackend()
      backend.connect(makeHandlers())
      expect(FakeWebSocket.instances).toHaveLength(1)
      backend.disconnect()
    })

    it('disconnects cleanly', () => {
      const backend = makeBackend()
      backend.connect(makeHandlers())
      const ws = FakeWebSocket.instances[0]
      backend.disconnect()
      expect(ws.close).toHaveBeenCalledTimes(1)
    })

    it('calls onConnected on first open', () => {
      const onConnected = vi.fn()
      const backend = makeBackend()
      backend.connect(makeHandlers({ onConnected }))
      FakeWebSocket.instances[0].onopen?.(new Event('open'))
      expect(onConnected).toHaveBeenCalledTimes(1)
      backend.disconnect()
    })

    it('calls onConnected again on reconnect so the hook can re-send client_ready', async () => {
      const onConnected = vi.fn()
      const backend = makeBackend()
      backend.connect(makeHandlers({ onConnected }))

      // Open -> first onConnected
      FakeWebSocket.instances[0].onopen?.(new Event('open'))
      expect(onConnected).toHaveBeenCalledTimes(1)

      // Close triggers backoff reconnect
      FakeWebSocket.instances[0].onclose?.(new Event('close') as CloseEvent)
      await vi.advanceTimersByTimeAsync(500)
      expect(FakeWebSocket.instances).toHaveLength(2)

      // New socket opens -> second onConnected
      FakeWebSocket.instances[1].onopen?.(new Event('open'))
      expect(onConnected).toHaveBeenCalledTimes(2)
      backend.disconnect()
    })
  })

  describe('exponential backoff schedule', () => {
    it('reconnects at 500ms after the first close', async () => {
      const backend = makeBackend()
      backend.connect(makeHandlers())
      // Force close without opening
      FakeWebSocket.instances[0].onclose?.(new Event('close') as CloseEvent)
      expect(FakeWebSocket.instances).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(500)
      expect(FakeWebSocket.instances).toHaveLength(2)
      backend.disconnect()
    })

    it('doubles delay on each consecutive close: 500, 1000, 2000, 4000, 8000, caps at 8000', async () => {
      const backend = makeBackend()
      backend.connect(makeHandlers())

      const expectedDelays = [500, 1000, 2000, 4000, 8000, 8000]
      for (const delay of expectedDelays) {
        const countBefore = FakeWebSocket.instances.length
        FakeWebSocket.instances[countBefore - 1].onclose?.(new Event('close') as CloseEvent)
        await vi.advanceTimersByTimeAsync(delay - 1)
        expect(FakeWebSocket.instances).toHaveLength(countBefore) // not yet
        await vi.advanceTimersByTimeAsync(1)
        expect(FakeWebSocket.instances).toHaveLength(countBefore + 1) // reconnected
      }
      backend.disconnect()
    })

    it('resets backoff to 500ms after onopen', async () => {
      const backend = makeBackend()
      backend.connect(makeHandlers())

      // First close -> 500ms
      FakeWebSocket.instances[0].onclose?.(new Event('close') as CloseEvent)
      await vi.advanceTimersByTimeAsync(500)
      expect(FakeWebSocket.instances).toHaveLength(2)

      // Second close without open -> 1000ms (attempt=1)
      FakeWebSocket.instances[1].onclose?.(new Event('close') as CloseEvent)
      await vi.advanceTimersByTimeAsync(999)
      expect(FakeWebSocket.instances).toHaveLength(2) // not yet
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeWebSocket.instances).toHaveLength(3)

      // onopen resets attempts; close -> 500ms again
      FakeWebSocket.instances[2].onopen?.(new Event('open'))
      FakeWebSocket.instances[2].onclose?.(new Event('close') as CloseEvent)
      await vi.advanceTimersByTimeAsync(500)
      expect(FakeWebSocket.instances).toHaveLength(4)
      backend.disconnect()
    })
  })

  describe('binary frame routing', () => {
    it('routes first binary frame to onSnapshot', () => {
      const backend = makeBackend()
      const onSnapshot = vi.fn()
      const onRemoteUpdate = vi.fn()
      backend.connect(makeHandlers({ onSnapshot, onRemoteUpdate }))

      const ws = FakeWebSocket.instances[0]
      const bytes = new Uint8Array([1, 2, 3])
      ws.onmessage?.(new MessageEvent('message', { data: bytes.buffer }))

      expect(onSnapshot).toHaveBeenCalledTimes(1)
      expect(onSnapshot).toHaveBeenCalledWith(expect.any(Uint8Array))
      expect(onRemoteUpdate).not.toHaveBeenCalled()
      backend.disconnect()
    })

    it('routes subsequent binary frames to onRemoteUpdate', () => {
      const backend = makeBackend()
      const onSnapshot = vi.fn()
      const onRemoteUpdate = vi.fn()
      backend.connect(makeHandlers({ onSnapshot, onRemoteUpdate }))

      const ws = FakeWebSocket.instances[0]
      const first = new Uint8Array([1])
      const second = new Uint8Array([2])
      const third = new Uint8Array([3])

      ws.onmessage?.(new MessageEvent('message', { data: first.buffer }))
      ws.onmessage?.(new MessageEvent('message', { data: second.buffer }))
      ws.onmessage?.(new MessageEvent('message', { data: third.buffer }))

      expect(onSnapshot).toHaveBeenCalledTimes(1)
      expect(onRemoteUpdate).toHaveBeenCalledTimes(2)
      backend.disconnect()
    })

    it('routes first frame after reconnect to onRemoteUpdate (import), not onSnapshot (replace)', async () => {
      // Reconnecting imports into the existing doc — replacing it would destroy
      // local unsynced edits and UndoManager history.
      const backend = makeBackend()
      const onSnapshot = vi.fn()
      const onRemoteUpdate = vi.fn()
      backend.connect(makeHandlers({ onSnapshot, onRemoteUpdate }))

      const ws0 = FakeWebSocket.instances[0]
      // First frame on initial connection → snapshot.
      ws0.onmessage?.(new MessageEvent('message', { data: new Uint8Array([1]).buffer }))
      expect(onSnapshot).toHaveBeenCalledTimes(1)
      expect(onRemoteUpdate).toHaveBeenCalledTimes(0)

      // Close and reconnect.
      ws0.onclose?.(new Event('close') as CloseEvent)
      await vi.advanceTimersByTimeAsync(500)
      expect(FakeWebSocket.instances).toHaveLength(2)

      // First frame on the reconnected socket → import (merge), NOT snapshot (replace).
      const ws1 = FakeWebSocket.instances[1]
      ws1.onmessage?.(new MessageEvent('message', { data: new Uint8Array([2]).buffer }))
      expect(onSnapshot).toHaveBeenCalledTimes(1)
      expect(onRemoteUpdate).toHaveBeenCalledTimes(1)

      // Subsequent frames also route to onRemoteUpdate.
      ws1.onmessage?.(new MessageEvent('message', { data: new Uint8Array([3]).buffer }))
      expect(onSnapshot).toHaveBeenCalledTimes(1)
      expect(onRemoteUpdate).toHaveBeenCalledTimes(2)
      backend.disconnect()
    })
  })

  describe('pushLocalUpdate', () => {
    it('sends bytes through the current websocket when OPEN', () => {
      const backend = makeBackend()
      backend.connect(makeHandlers())

      const ws = FakeWebSocket.instances[0]
      ws.readyState = FakeWebSocket.OPEN
      const bytes = new Uint8Array([10, 20, 30])
      backend.pushLocalUpdate(bytes)

      expect(ws.send).toHaveBeenCalledTimes(1)
      backend.disconnect()
    })

    it('does not send when the socket is not OPEN (e.g. CONNECTING after reconnect)', () => {
      // subscribeLocalUpdates can fire between ws.onclose replacing this.ws
      // with a newly-created CONNECTING socket and that socket reaching OPEN.
      // Sending on CONNECTING throws InvalidStateError; the guard must prevent that.
      const backend = makeBackend()
      backend.connect(makeHandlers())

      const ws = FakeWebSocket.instances[0]
      ws.readyState = FakeWebSocket.CONNECTING
      const bytes = new Uint8Array([10, 20, 30])
      backend.pushLocalUpdate(bytes)

      expect(ws.send).not.toHaveBeenCalled()
      backend.disconnect()
    })
  })

  describe('text message dispatch', () => {
    it('dispatches version_created to onVersionCreated', () => {
      const backend = makeBackend()
      const onVersionCreated = vi.fn()
      backend.connect(makeHandlers({ onVersionCreated }))
      const ws = FakeWebSocket.instances[0]

      const msg = { type: 'version_created', version: { id: 'v1', slug: 'sl', createdAt: '2024-01-01', elementCount: 1, auto: true, hasThumbnail: false } }
      ws.onmessage?.(new MessageEvent('message', { data: JSON.stringify(msg) }))

      expect(onVersionCreated).toHaveBeenCalledTimes(1)
      expect(onVersionCreated).toHaveBeenCalledWith(msg.version)
      backend.disconnect()
    })

    it('dispatches restore_started to onRestoreStarted', () => {
      const backend = makeBackend()
      const onRestoreStarted = vi.fn()
      backend.connect(makeHandlers({ onRestoreStarted }))
      const ws = FakeWebSocket.instances[0]

      ws.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'restore_started', label: 'Restoring v1' }) }))
      expect(onRestoreStarted).toHaveBeenCalledWith({ label: 'Restoring v1' })
      backend.disconnect()
    })

    it('dispatches restore_complete to onRestoreComplete', () => {
      const backend = makeBackend()
      const onRestoreComplete = vi.fn()
      backend.connect(makeHandlers({ onRestoreComplete }))
      const ws = FakeWebSocket.instances[0]

      ws.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'restore_complete' }) }))
      expect(onRestoreComplete).toHaveBeenCalledTimes(1)
      backend.disconnect()
    })

    it('dispatches head_changed to onHeadChanged', () => {
      const backend = makeBackend()
      const onHeadChanged = vi.fn()
      backend.connect(makeHandlers({ onHeadChanged }))
      const ws = FakeWebSocket.instances[0]

      ws.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'head_changed', head: 'main' }) }))
      expect(onHeadChanged).toHaveBeenCalledWith({ head: 'main' })
      backend.disconnect()
    })

    it('dispatches viewport_request to onViewportRequest and ACKs via ws.send', () => {
      const backend = makeBackend()
      const onViewportRequest = vi.fn()
      backend.connect(makeHandlers({ onViewportRequest }))
      const ws = FakeWebSocket.instances[0]
      ws.readyState = FakeWebSocket.OPEN

      const msg = { type: 'viewport_request', requestId: 'req-1', mode: 'fit' }
      ws.onmessage?.(new MessageEvent('message', { data: JSON.stringify(msg) }))

      expect(onViewportRequest).toHaveBeenCalledTimes(1)
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'viewport_response', requestId: 'req-1' }))
      backend.disconnect()
    })

    it('dispatches export_request to onExportRequest', () => {
      const backend = makeBackend()
      const onExportRequest = vi.fn()
      backend.connect(makeHandlers({ onExportRequest }))
      const ws = FakeWebSocket.instances[0]

      const msg = { type: 'export_request', requestId: 'exp-1' }
      ws.onmessage?.(new MessageEvent('message', { data: JSON.stringify(msg) }))

      expect(onExportRequest).toHaveBeenCalledTimes(1)
      backend.disconnect()
    })

    it('drops malformed JSON without calling any callback', () => {
      const backend = makeBackend()
      const onVersionCreated = vi.fn()
      backend.connect(makeHandlers({ onVersionCreated }))
      const ws = FakeWebSocket.instances[0]

      ws.onmessage?.(new MessageEvent('message', { data: 'not json{{{' }))
      expect(onVersionCreated).not.toHaveBeenCalled()
      backend.disconnect()
    })

    it('drops schema-mismatch messages without calling any callback', () => {
      const backend = makeBackend()
      const onVersionCreated = vi.fn()
      backend.connect(makeHandlers({ onVersionCreated }))
      const ws = FakeWebSocket.instances[0]

      ws.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'unknown_type', value: 42 }) }))
      expect(onVersionCreated).not.toHaveBeenCalled()
      backend.disconnect()
    })
  })

  describe('getFile', () => {
    it('calls apiFetch GET at the expected URL and returns Blob on ok', async () => {
      const fakeBlob = new Blob(['img'])
      apiFetchMock.mockResolvedValueOnce({ ok: true, blob: () => Promise.resolve(fakeBlob) })

      const backend = makeBackend()
      const result = await backend.getFile('file-abc')

      expect(apiFetchMock).toHaveBeenCalledWith(
        '/api/canvas/ws-sid/slug/file/file-abc',
      )
      expect(result).toBe(fakeBlob)
    })

    it('returns null when apiFetch response is not ok', async () => {
      apiFetchMock.mockResolvedValueOnce({ ok: false })

      const backend = makeBackend()
      const result = await backend.getFile('file-xyz')
      expect(result).toBeNull()
    })
  })

  describe('putFile', () => {
    it('delegates to uploadFiles with the correct arguments', async () => {
      uploadFilesMock.mockResolvedValueOnce(undefined)

      const backend = makeBackend()
      const entries: [string, { dataURL: string; mimeType: string; id: string; created: number }][] = [
        ['fid-1', { id: 'fid-1', mimeType: 'image/png', dataURL: 'data:image/png;base64,abc', created: 1 }],
      ]
      const onFileSuccess = vi.fn()
      await backend.putFile(entries as Parameters<typeof backend.putFile>[0], onFileSuccess)

      expect(uploadFilesMock).toHaveBeenCalledWith(entries, 'ws-sid', 'slug', onFileSuccess)
    })
  })

  describe('sendClientReady', () => {
    it('sends a client_ready JSON message when the socket is OPEN', () => {
      const backend = makeBackend()
      backend.connect(makeHandlers())
      const ws = FakeWebSocket.instances[0]
      ws.readyState = FakeWebSocket.OPEN
      backend.sendClientReady()
      expect(ws.send).toHaveBeenCalledTimes(1)
      expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({ type: 'client_ready' })
      backend.disconnect()
    })

    it('does not send when the socket is not OPEN', () => {
      const backend = makeBackend()
      backend.connect(makeHandlers())
      const ws = FakeWebSocket.instances[0]
      ws.readyState = FakeWebSocket.CONNECTING
      backend.sendClientReady()
      expect(ws.send).not.toHaveBeenCalled()
      backend.disconnect()
    })
  })

  describe('sendExportResponse', () => {
    it('sends an export_response JSON message with requestId and data', () => {
      const backend = makeBackend()
      backend.connect(makeHandlers())
      const ws = FakeWebSocket.instances[0]
      ws.readyState = FakeWebSocket.OPEN
      backend.sendExportResponse('exp-7', 'data:image/png;base64,abc')
      expect(ws.send).toHaveBeenCalledTimes(1)
      expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
        type: 'export_response',
        requestId: 'exp-7',
        data: 'data:image/png;base64,abc',
      })
      backend.disconnect()
    })

    it('does not send when the socket is not OPEN (e.g. CONNECTING after reconnect)', () => {
      // The export flow is async — a reconnect during exportToBlob replaces
      // this.ws with a CONNECTING socket. Sending on CONNECTING throws
      // InvalidStateError in browsers; the guard must prevent that.
      const backend = makeBackend()
      backend.connect(makeHandlers())
      const ws = FakeWebSocket.instances[0]
      // Simulate the socket being in CONNECTING state (e.g. mid-reconnect).
      ws.readyState = FakeWebSocket.CONNECTING
      backend.sendExportResponse('exp-8', 'data:image/png;base64,xyz')
      expect(ws.send).not.toHaveBeenCalled()
      backend.disconnect()
    })
  })

  describe('client→server message serialization (Zod schema discipline)', () => {
    it('sendClientReady payload matches clientReadyMessageSchema', async () => {
      const { clientReadyMessageSchema } = await import('../../shared/ws-messages.js')
      const backend = makeBackend()
      backend.connect(makeHandlers())
      const ws = FakeWebSocket.instances[0]
      ws.readyState = FakeWebSocket.OPEN
      backend.sendClientReady()
      const parsed = clientReadyMessageSchema.safeParse(JSON.parse(ws.send.mock.calls[0][0]))
      expect(parsed.success).toBe(true)
      backend.disconnect()
    })

    it('viewport_request inline ACK payload matches viewportResponseMessageSchema', async () => {
      // The ACK is sent inline in the onmessage handler on the closure-captured socket,
      // not via a public sendViewportResponse method. This test verifies that the inline
      // ACK serializes to a schema-valid viewport_response.
      const { viewportResponseMessageSchema } = await import('../../shared/ws-messages.js')
      const backend = makeBackend()
      backend.connect(makeHandlers())
      const ws = FakeWebSocket.instances[0]
      ws.readyState = FakeWebSocket.OPEN
      ws.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'viewport_request', requestId: 'vp-req', mode: 'fit' }) }))
      const parsed = viewportResponseMessageSchema.safeParse(JSON.parse(ws.send.mock.calls[0][0]))
      expect(parsed.success).toBe(true)
      backend.disconnect()
    })

    it('sendExportResponse payload matches exportResponseMessageSchema', async () => {
      const { exportResponseMessageSchema } = await import('../../shared/ws-messages.js')
      const backend = makeBackend()
      backend.connect(makeHandlers())
      const ws = FakeWebSocket.instances[0]
      ws.readyState = FakeWebSocket.OPEN
      backend.sendExportResponse('ex-req', 'data:image/png;base64,xyz')
      const parsed = exportResponseMessageSchema.safeParse(JSON.parse(ws.send.mock.calls[0][0]))
      expect(parsed.success).toBe(true)
      backend.disconnect()
    })
  })

  describe('z.infer mutation-check (zod-schema-discipline)', () => {
    // This test confirms that the CanvasBackend callback types are derived from
    // the shared Zod schemas, NOT from a parallel hand-written interface.
    // A divergent hand-written interface (e.g. wrong field type) would make the
    // type system reject the DaemonBackend implementation at compile time — the
    // absence of a TS error here, combined with the typecheck CI gate, is the
    // runtime proxy for that guarantee.
    it('onVersionCreated receives payload shaped by z.infer<typeof versionCreatedPayloadSchema>', () => {
      const backend = makeBackend()
      const onVersionCreated = vi.fn()
      backend.connect(makeHandlers({ onVersionCreated }))
      const ws = FakeWebSocket.instances[0]

      // Payload with optional operator field omitted — must match z.infer shape.
      const payload = {
        id: 'v1',
        slug: 'my-canvas',
        createdAt: '2024-01-01T00:00:00Z',
        elementCount: 5,
        auto: false,
        hasThumbnail: true,
        label: 'checkpoint',
      }
      ws.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'version_created', version: payload }) }))

      expect(onVersionCreated).toHaveBeenCalledWith(payload)
      backend.disconnect()
    })
  })
})
