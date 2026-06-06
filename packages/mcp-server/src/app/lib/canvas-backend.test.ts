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

  describe('connection lifecycle', () => {
    it('creates one WebSocket on connect()', () => {
      const backend = makeBackend()
      const handlers = { onSnapshot: vi.fn(), onRemoteUpdate: vi.fn(), onVersionCreated: vi.fn(), onRestoreStarted: vi.fn(), onRestoreComplete: vi.fn(), onHeadChanged: vi.fn(), onViewportRequest: vi.fn(), onExportRequest: vi.fn() }
      backend.connect(handlers)
      expect(FakeWebSocket.instances).toHaveLength(1)
      backend.disconnect()
    })

    it('disconnects cleanly', () => {
      const backend = makeBackend()
      const handlers = { onSnapshot: vi.fn(), onRemoteUpdate: vi.fn(), onVersionCreated: vi.fn(), onRestoreStarted: vi.fn(), onRestoreComplete: vi.fn(), onHeadChanged: vi.fn(), onViewportRequest: vi.fn(), onExportRequest: vi.fn() }
      backend.connect(handlers)
      const ws = FakeWebSocket.instances[0]
      backend.disconnect()
      expect(ws.close).toHaveBeenCalledTimes(1)
    })
  })

  describe('exponential backoff schedule', () => {
    it('reconnects at 500ms after the first close', async () => {
      const backend = makeBackend()
      const handlers = { onSnapshot: vi.fn(), onRemoteUpdate: vi.fn(), onVersionCreated: vi.fn(), onRestoreStarted: vi.fn(), onRestoreComplete: vi.fn(), onHeadChanged: vi.fn(), onViewportRequest: vi.fn(), onExportRequest: vi.fn() }
      backend.connect(handlers)
      // Force close without opening
      FakeWebSocket.instances[0].onclose?.(new Event('close') as CloseEvent)
      expect(FakeWebSocket.instances).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(500)
      expect(FakeWebSocket.instances).toHaveLength(2)
      backend.disconnect()
    })

    it('doubles delay on each consecutive close: 500, 1000, 2000, 4000, 8000, caps at 8000', async () => {
      const backend = makeBackend()
      const handlers = { onSnapshot: vi.fn(), onRemoteUpdate: vi.fn(), onVersionCreated: vi.fn(), onRestoreStarted: vi.fn(), onRestoreComplete: vi.fn(), onHeadChanged: vi.fn(), onViewportRequest: vi.fn(), onExportRequest: vi.fn() }
      backend.connect(handlers)

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
      const handlers = { onSnapshot: vi.fn(), onRemoteUpdate: vi.fn(), onVersionCreated: vi.fn(), onRestoreStarted: vi.fn(), onRestoreComplete: vi.fn(), onHeadChanged: vi.fn(), onViewportRequest: vi.fn(), onExportRequest: vi.fn() }
      backend.connect(handlers)

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
      const handlers = { onSnapshot, onRemoteUpdate, onVersionCreated: vi.fn(), onRestoreStarted: vi.fn(), onRestoreComplete: vi.fn(), onHeadChanged: vi.fn(), onViewportRequest: vi.fn(), onExportRequest: vi.fn() }
      backend.connect(handlers)

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
      const handlers = { onSnapshot, onRemoteUpdate, onVersionCreated: vi.fn(), onRestoreStarted: vi.fn(), onRestoreComplete: vi.fn(), onHeadChanged: vi.fn(), onViewportRequest: vi.fn(), onExportRequest: vi.fn() }
      backend.connect(handlers)

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

    it('resets snapshot state after reconnect so new socket fires onSnapshot again', async () => {
      const backend = makeBackend()
      const onSnapshot = vi.fn()
      const onRemoteUpdate = vi.fn()
      const handlers = { onSnapshot, onRemoteUpdate, onVersionCreated: vi.fn(), onRestoreStarted: vi.fn(), onRestoreComplete: vi.fn(), onHeadChanged: vi.fn(), onViewportRequest: vi.fn(), onExportRequest: vi.fn() }
      backend.connect(handlers)

      const ws0 = FakeWebSocket.instances[0]
      ws0.onmessage?.(new MessageEvent('message', { data: new Uint8Array([1]).buffer }))
      expect(onSnapshot).toHaveBeenCalledTimes(1)

      // Close and reconnect
      ws0.onclose?.(new Event('close') as CloseEvent)
      await vi.advanceTimersByTimeAsync(500)
      expect(FakeWebSocket.instances).toHaveLength(2)

      const ws1 = FakeWebSocket.instances[1]
      ws1.onmessage?.(new MessageEvent('message', { data: new Uint8Array([2]).buffer }))
      expect(onSnapshot).toHaveBeenCalledTimes(2)
      expect(onRemoteUpdate).not.toHaveBeenCalled()
      backend.disconnect()
    })
  })

  describe('pushLocalUpdate', () => {
    it('sends bytes through the current websocket', () => {
      const backend = makeBackend()
      const handlers = { onSnapshot: vi.fn(), onRemoteUpdate: vi.fn(), onVersionCreated: vi.fn(), onRestoreStarted: vi.fn(), onRestoreComplete: vi.fn(), onHeadChanged: vi.fn(), onViewportRequest: vi.fn(), onExportRequest: vi.fn() }
      backend.connect(handlers)

      const ws = FakeWebSocket.instances[0]
      ws.readyState = FakeWebSocket.OPEN
      const bytes = new Uint8Array([10, 20, 30])
      backend.pushLocalUpdate(bytes)

      expect(ws.send).toHaveBeenCalledTimes(1)
      backend.disconnect()
    })
  })

  describe('text message dispatch', () => {
    it('dispatches version_created to onVersionCreated', () => {
      const backend = makeBackend()
      const onVersionCreated = vi.fn()
      const handlers = { onSnapshot: vi.fn(), onRemoteUpdate: vi.fn(), onVersionCreated, onRestoreStarted: vi.fn(), onRestoreComplete: vi.fn(), onHeadChanged: vi.fn(), onViewportRequest: vi.fn(), onExportRequest: vi.fn() }
      backend.connect(handlers)
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
      const handlers = { onSnapshot: vi.fn(), onRemoteUpdate: vi.fn(), onVersionCreated: vi.fn(), onRestoreStarted, onRestoreComplete: vi.fn(), onHeadChanged: vi.fn(), onViewportRequest: vi.fn(), onExportRequest: vi.fn() }
      backend.connect(handlers)
      const ws = FakeWebSocket.instances[0]

      ws.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'restore_started', label: 'Restoring v1' }) }))
      expect(onRestoreStarted).toHaveBeenCalledWith({ label: 'Restoring v1' })
      backend.disconnect()
    })

    it('dispatches restore_complete to onRestoreComplete', () => {
      const backend = makeBackend()
      const onRestoreComplete = vi.fn()
      const handlers = { onSnapshot: vi.fn(), onRemoteUpdate: vi.fn(), onVersionCreated: vi.fn(), onRestoreStarted: vi.fn(), onRestoreComplete, onHeadChanged: vi.fn(), onViewportRequest: vi.fn(), onExportRequest: vi.fn() }
      backend.connect(handlers)
      const ws = FakeWebSocket.instances[0]

      ws.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'restore_complete' }) }))
      expect(onRestoreComplete).toHaveBeenCalledTimes(1)
      backend.disconnect()
    })

    it('dispatches head_changed to onHeadChanged', () => {
      const backend = makeBackend()
      const onHeadChanged = vi.fn()
      const handlers = { onSnapshot: vi.fn(), onRemoteUpdate: vi.fn(), onVersionCreated: vi.fn(), onRestoreStarted: vi.fn(), onRestoreComplete: vi.fn(), onHeadChanged, onViewportRequest: vi.fn(), onExportRequest: vi.fn() }
      backend.connect(handlers)
      const ws = FakeWebSocket.instances[0]

      ws.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'head_changed', head: 'main' }) }))
      expect(onHeadChanged).toHaveBeenCalledWith({ head: 'main' })
      backend.disconnect()
    })

    it('dispatches viewport_request to onViewportRequest and ACKs via ws.send', () => {
      const backend = makeBackend()
      const onViewportRequest = vi.fn()
      const handlers = { onSnapshot: vi.fn(), onRemoteUpdate: vi.fn(), onVersionCreated: vi.fn(), onRestoreStarted: vi.fn(), onRestoreComplete: vi.fn(), onHeadChanged: vi.fn(), onViewportRequest, onExportRequest: vi.fn() }
      backend.connect(handlers)
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
      const handlers = { onSnapshot: vi.fn(), onRemoteUpdate: vi.fn(), onVersionCreated: vi.fn(), onRestoreStarted: vi.fn(), onRestoreComplete: vi.fn(), onHeadChanged: vi.fn(), onViewportRequest: vi.fn(), onExportRequest }
      backend.connect(handlers)
      const ws = FakeWebSocket.instances[0]

      const msg = { type: 'export_request', requestId: 'exp-1' }
      ws.onmessage?.(new MessageEvent('message', { data: JSON.stringify(msg) }))

      expect(onExportRequest).toHaveBeenCalledTimes(1)
      backend.disconnect()
    })

    it('drops malformed JSON without calling any callback', () => {
      const backend = makeBackend()
      const onVersionCreated = vi.fn()
      const handlers = { onSnapshot: vi.fn(), onRemoteUpdate: vi.fn(), onVersionCreated, onRestoreStarted: vi.fn(), onRestoreComplete: vi.fn(), onHeadChanged: vi.fn(), onViewportRequest: vi.fn(), onExportRequest: vi.fn() }
      backend.connect(handlers)
      const ws = FakeWebSocket.instances[0]

      ws.onmessage?.(new MessageEvent('message', { data: 'not json{{{' }))
      expect(onVersionCreated).not.toHaveBeenCalled()
      backend.disconnect()
    })

    it('drops schema-mismatch messages without calling any callback', () => {
      const backend = makeBackend()
      const onVersionCreated = vi.fn()
      const handlers = { onSnapshot: vi.fn(), onRemoteUpdate: vi.fn(), onVersionCreated, onRestoreStarted: vi.fn(), onRestoreComplete: vi.fn(), onHeadChanged: vi.fn(), onViewportRequest: vi.fn(), onExportRequest: vi.fn() }
      backend.connect(handlers)
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
      const handlers = { onSnapshot: vi.fn(), onRemoteUpdate: vi.fn(), onVersionCreated, onRestoreStarted: vi.fn(), onRestoreComplete: vi.fn(), onHeadChanged: vi.fn(), onViewportRequest: vi.fn(), onExportRequest: vi.fn() }
      backend.connect(handlers)
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
