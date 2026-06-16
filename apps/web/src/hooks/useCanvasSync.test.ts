/**
 * useCanvasSync unit tests — jsdom layer.
 *
 * @excalidraw/excalidraw is mocked because it loads roughjs native bindings
 * that are not available in jsdom. The hook's sync contract is tested via
 * a fake CanvasBackend and a minimal ExcalidrawImperativeAPI stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import type {
  CanvasBackend,
  CanvasBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'

// Mock excalidraw before importing the hook — restoreElements must return its input unchanged.
vi.mock('@excalidraw/excalidraw', () => ({
  restoreElements: (els: unknown[]) => els,
  CaptureUpdateAction: { NEVER: 'NEVER' },
}))

// eslint-disable-next-line import/first
import { useCanvasSync } from './useCanvasSync.js'

// Minimal ExcalidrawImperativeAPI stub — only the methods the hook uses.
function makeApiStub() {
  return {
    updateScene: vi.fn(),
    addFiles: vi.fn(),
    getSceneElements: vi.fn(() => []),
    getAppState: vi.fn(() => ({ scrollX: 0, scrollY: 0, zoom: { value: 1 } })),
  }
}

type FakeBackendControl = {
  handlers: CanvasBackendHandlers | null
  disconnectCalled: boolean
  pushLocalUpdateCalls: Uint8Array[]
}

function makeFakeBackend(): CanvasBackend & { _ctrl: FakeBackendControl } {
  const ctrl: FakeBackendControl = {
    handlers: null,
    disconnectCalled: false,
    pushLocalUpdateCalls: [],
  }
  const backend: CanvasBackend & { _ctrl: FakeBackendControl } = {
    _ctrl: ctrl,
    connect(handlers) {
      ctrl.handlers = handlers
      handlers.onConnected()
    },
    disconnect() {
      ctrl.disconnectCalled = true
      ctrl.handlers = null
    },
    pushLocalUpdate(bytes) {
      ctrl.pushLocalUpdateCalls.push(bytes)
      return Promise.resolve()
    },
    getFile: async () => null,
    putFile: async () => {},
    sendClientReady: () => {},
    sendExportResponse: () => {},
  }
  return backend
}

function makeEmptyLoroSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  return doc.export({ mode: 'snapshot' })
}

describe('useCanvasSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls updateScene on the excalidraw API after onSnapshot fires', async () => {
    const backend = makeFakeBackend()
    const api = makeApiStub()

    const { result } = renderHook(() => useCanvasSync(backend))

    // Register the excalidraw API.
    act(() => {
      result.current.setExcalidrawAPI(api as never)
    })

    // Fire an empty snapshot from the backend.
    await act(async () => {
      backend._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
      await vi.runAllTimersAsync()
    })

    expect(api.updateScene).toHaveBeenCalled()
  })

  it('sets syncStatus to "connected" when onConnected fires', () => {
    const backend = makeFakeBackend()
    const { result } = renderHook(() => useCanvasSync(backend))
    expect(result.current.syncStatus).toBe('connected')
  })

  it('sets syncStatus to "error" when onError fires', async () => {
    const backend = makeFakeBackend()
    const { result } = renderHook(() => useCanvasSync(backend))

    act(() => {
      backend._ctrl.handlers!.onError?.('storage-failure')
    })

    expect(result.current.syncStatus).toBe('error')
  })

  it('calls backend.pushLocalUpdate after onChange debounce elapses', async () => {
    const backend = makeFakeBackend()
    const api = makeApiStub()

    const { result } = renderHook(() => useCanvasSync(backend))

    act(() => {
      result.current.setExcalidrawAPI(api as never)
    })

    // Deliver a snapshot first so docRef is populated.
    await act(async () => {
      backend._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
      await vi.runAllTimersAsync()
    })

    const priorCallCount = backend._ctrl.pushLocalUpdateCalls.length

    // Trigger a scene change with a non-empty element so Loro actually writes a commit.
    const fakeEl = { type: 'rectangle', id: 'el-1', x: 0, y: 0, width: 100, height: 100 }
    act(() => {
      result.current.onChange([fakeEl as never], {} as never, {})
    })

    // Before debounce: no new call.
    expect(backend._ctrl.pushLocalUpdateCalls.length).toBe(priorCallCount)

    // Advance past debounce.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    // After debounce: at least one additional push (triggered by LoroDoc.subscribeLocalUpdates).
    expect(backend._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(priorCallCount)
  })

  it('calls backend.disconnect on unmount', () => {
    const backend = makeFakeBackend()
    const { unmount } = renderHook(() => useCanvasSync(backend))
    unmount()
    expect(backend._ctrl.disconnectCalled).toBe(true)
  })

  it('does not push after unmount when debounce timer fires', async () => {
    const backend = makeFakeBackend()
    const api = makeApiStub()

    const { result, unmount } = renderHook(() => useCanvasSync(backend))

    act(() => {
      result.current.setExcalidrawAPI(api as never)
    })

    await act(async () => {
      backend._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
      await vi.runAllTimersAsync()
    })

    const fakeEl = { type: 'rectangle', id: 'el-2', x: 0, y: 0, width: 50, height: 50 }
    act(() => {
      result.current.onChange([fakeEl as never], {} as never, {})
    })

    unmount()

    const callsAtUnmount = backend._ctrl.pushLocalUpdateCalls.length

    // Fire the debounce that was queued before unmount.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    // Push count must not increase after unmount.
    expect(backend._ctrl.pushLocalUpdateCalls.length).toBe(callsAtUnmount)
  })
})
