// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// useWhiteboardSync imports @excalidraw/excalidraw, so replace it with a lightweight mock to avoid
// roughjs ESM resolution failures in this environment.
vi.mock('@excalidraw/excalidraw', () => ({
  exportToBlob: vi.fn(),
  CaptureUpdateAction: { NEVER: 'never' },
  restoreElements: vi.fn(),
}))

const { useWhiteboardSync } = await import('./useWhiteboardSync.js')

// Regression coverage for websocket auto-reconnect.
// One root cause behind export_png returning no_client was that a closed websocket never reconnected.
// This test avoids LoroDoc setup and watches only the close -> backoff -> reconnect sequence.

interface WsHandlers {
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
}

class FakeWebSocket implements WsHandlers {
  static instances: FakeWebSocket[] = []
  static CONNECTING = 0 as const
  static OPEN = 1 as const
  static CLOSING = 2 as const
  static CLOSED = 3 as const

  binaryType: BinaryType = 'blob'
  readyState: number = FakeWebSocket.CONNECTING
  url: string
  protocol = ''
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  send = vi.fn()
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
  dispatchEvent = vi.fn()
  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.(new Event('close') as CloseEvent)
  })

  constructor(url: string | URL, _protocols?: string | string[]) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }
}

describe('useWhiteboardSync WS reconnect', () => {
  let originalWebSocket: typeof WebSocket

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    originalWebSocket = globalThis.WebSocket
    // Replace jsdom's global WebSocket.
    Object.defineProperty(globalThis, 'WebSocket', {
      value: FakeWebSocket,
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(globalThis, 'WebSocket', {
      value: originalWebSocket,
      writable: true,
      configurable: true,
    })
  })

  it('creates one websocket on mount', () => {
    renderHook(() => useWhiteboardSync('s', 'c'))
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('reconnects 500ms after close', async () => {
    renderHook(() => useWhiteboardSync('s', 'c'))
    expect(FakeWebSocket.instances).toHaveLength(1)
    act(() => {
      FakeWebSocket.instances[0]!.onclose?.(new Event('close') as CloseEvent)
    })
    expect(FakeWebSocket.instances).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('increases backoff on consecutive closes and resets it after onopen', async () => {
    renderHook(() => useWhiteboardSync('s', 'c'))
    expect(FakeWebSocket.instances).toHaveLength(1)

    // First close -> 500ms reconnect.
    act(() => FakeWebSocket.instances[0]!.onclose?.(new Event('close') as CloseEvent))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(FakeWebSocket.instances).toHaveLength(2)

    // Second close without opening -> backoff grows to 1000ms.
    act(() => FakeWebSocket.instances[1]!.onclose?.(new Event('close') as CloseEvent))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(FakeWebSocket.instances).toHaveLength(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(FakeWebSocket.instances).toHaveLength(3)

    // onopen resets attempts, so the next close goes back to 500ms.
    act(() => FakeWebSocket.instances[2]!.onopen?.(new Event('open')))
    act(() => FakeWebSocket.instances[2]!.onclose?.(new Event('close') as CloseEvent))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(FakeWebSocket.instances).toHaveLength(4)
  })

  it('cancels the reconnect timer on unmount', async () => {
    const { unmount } = renderHook(() => useWhiteboardSync('s', 'c'))
    act(() => FakeWebSocket.instances[0]!.onclose?.(new Event('close') as CloseEvent))
    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    // No reconnect should happen after unmount.
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
