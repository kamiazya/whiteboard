// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'

vi.mock('@excalidraw/excalidraw', () => ({
  exportToBlob: vi.fn(),
  CaptureUpdateAction: { NEVER: 'never' },
  restoreElements: vi.fn(),
}))

const commitAfterUploadMock = vi.fn((...args: unknown[]): Promise<void> => {
  void args
  return Promise.resolve()
})
vi.mock('../lib/commit-pipeline.js', () => ({
  commitAfterUpload: commitAfterUploadMock,
}))

const { useWhiteboardSync } = await import('./useWhiteboardSync.js')

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

  constructor(url: string | URL) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }
}

describe('useWhiteboardSync onSceneChange lifecycle', () => {
  let originalWebSocket: typeof WebSocket

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    commitAfterUploadMock.mockClear()
    originalWebSocket = globalThis.WebSocket
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

  it('keeps a stable onSceneChange reference when re-rendered with the same canvas key', () => {
    const { result, rerender } = renderHook(
      ({ s, c }: { s: string; c: string }) => useWhiteboardSync(s, c),
      { initialProps: { s: 'sid', c: 'slug' } },
    )

    const first = result.current.onSceneChange
    rerender({ s: 'sid', c: 'slug' })
    rerender({ s: 'sid', c: 'slug' })

    expect(result.current.onSceneChange).toBe(first)
  })

  it('replaces onSceneChange when the canvas key changes', () => {
    const { result, rerender } = renderHook(
      ({ s, c }: { s: string; c: string }) => useWhiteboardSync(s, c),
      { initialProps: { s: 'sid', c: 'slug-a' } },
    )

    const first = result.current.onSceneChange
    rerender({ s: 'sid', c: 'slug-b' })

    expect(result.current.onSceneChange).not.toBe(first)
  })

  it('clears the pending debounce timer when the canvas key changes', () => {
    const { result, rerender } = renderHook(
      ({ s, c }: { s: string; c: string }) => useWhiteboardSync(s, c),
      { initialProps: { s: 'sid', c: 'slug-a' } },
    )

    const baseline = vi.getTimerCount()
    act(() => {
      result.current.onSceneChange?.([], {})
    })
    // The debounce schedules exactly one 300ms timer for the next commit.
    expect(vi.getTimerCount()).toBe(baseline + 1)

    // Switching the canvas key must cancel the pending timer so the old
    // closure cannot leak a write into the new canvas.
    rerender({ s: 'sid', c: 'slug-b' })
    expect(vi.getTimerCount()).toBe(baseline)
  })

  it('clears the pending debounce timer on unmount so the hook does not hold a setTimeout open', () => {
    const { result, unmount } = renderHook(() => useWhiteboardSync('sid', 'slug'))

    const baseline = vi.getTimerCount()
    act(() => {
      result.current.onSceneChange?.([], {})
    })
    expect(vi.getTimerCount()).toBe(baseline + 1)

    unmount()
    // Effect cleanup should cancel the still-pending debounce timer.
    expect(vi.getTimerCount()).toBe(baseline)
  })

  it('keeps the same onSceneChange reference under StrictMode double-invoke for a stable canvas key', () => {
    const { result, rerender } = renderHook(
      ({ s, c }: { s: string; c: string }) => useWhiteboardSync(s, c),
      {
        initialProps: { s: 'sid', c: 'slug' },
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <StrictMode>{children}</StrictMode>
        ),
      },
    )

    const first = result.current.onSceneChange
    rerender({ s: 'sid', c: 'slug' })

    expect(result.current.onSceneChange).toBe(first)
  })
})
