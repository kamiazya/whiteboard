/**
 * useCanvasSync unit tests — jsdom layer.
 *
 * @excalidraw/excalidraw is mocked because it loads roughjs native bindings
 * that are not available in jsdom. The hook's sync contract is tested via
 * a fake CanvasBackend and a minimal ExcalidrawImperativeAPI stub.
 */

import type {
  CanvasBackend,
  CanvasBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import { act, renderHook } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('does not connect when backend is null, and onChange is a safe no-op', () => {
    const { result } = renderHook(({ backend }) => useCanvasSync(backend), {
      initialProps: { backend: null as CanvasBackend | null },
    })

    expect(result.current.syncStatus).toBe('idle')
    // Calling onChange with no backend must not throw.
    expect(() => result.current.onChange([], {} as never, {})).not.toThrow()
  })

  it('connects when backend changes from null to a real backend', () => {
    const backend = makeFakeBackend()
    const { result, rerender } = renderHook(({ backend }) => useCanvasSync(backend), {
      initialProps: { backend: null as CanvasBackend | null },
    })

    expect(result.current.syncStatus).toBe('idle')

    rerender({ backend })

    expect(backend._ctrl.handlers).not.toBeNull()
    expect(result.current.syncStatus).toBe('connected')
  })

  it('reconnects to a new backend when the backend prop changes, disconnecting the old one', async () => {
    const backendA = makeFakeBackend()
    const backendB = makeFakeBackend()
    const api = makeApiStub()

    const { result, rerender } = renderHook(({ backend }) => useCanvasSync(backend), {
      initialProps: { backend: backendA as CanvasBackend },
    })

    act(() => {
      result.current.setExcalidrawAPI(api as never)
    })

    await act(async () => {
      backendA._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
      await vi.runAllTimersAsync()
    })

    // Switch to backend B.
    rerender({ backend: backendB })

    expect(backendA._ctrl.disconnectCalled).toBe(true)
    expect(backendB._ctrl.handlers).not.toBeNull()

    await act(async () => {
      backendB._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
      await vi.runAllTimersAsync()
    })

    const aCallsBefore = backendA._ctrl.pushLocalUpdateCalls.length
    const bCallsBefore = backendB._ctrl.pushLocalUpdateCalls.length

    const fakeEl = { type: 'rectangle', id: 'el-3', x: 0, y: 0, width: 10, height: 10 }
    act(() => {
      result.current.onChange([fakeEl as never], {} as never, {})
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    // Writes after the switch reach B only, never A.
    expect(backendA._ctrl.pushLocalUpdateCalls.length).toBe(aCallsBefore)
    expect(backendB._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(bCallsBefore)
  })

  it('sets syncStatus to "error" and does not resurrect A when switching to a backend whose connect fails', () => {
    const backendA = makeFakeBackend()
    const api = makeApiStub()

    const { result, rerender } = renderHook(({ backend }) => useCanvasSync(backend), {
      initialProps: { backend: backendA as CanvasBackend },
    })

    act(() => {
      result.current.setExcalidrawAPI(api as never)
    })

    expect(result.current.syncStatus).toBe('connected')

    // Backend B fails to connect: fires onError synchronously instead of onConnected.
    const failingBackend: CanvasBackend & { _ctrl: FakeBackendControl } = {
      _ctrl: { handlers: null, disconnectCalled: false, pushLocalUpdateCalls: [] },
      connect(handlers) {
        handlers.onError?.('storage-failure')
      },
      disconnect() {},
      pushLocalUpdate: () => Promise.resolve(),
      getFile: async () => null,
      putFile: async () => {},
      sendClientReady: () => {},
      sendExportResponse: () => {},
    }

    act(() => {
      rerender({ backend: failingBackend })
    })

    expect(backendA._ctrl.disconnectCalled).toBe(true)
    expect(result.current.syncStatus).toBe('error')

    // Subsequent switch to a healthy backend still connects cleanly.
    const backendC = makeFakeBackend()
    act(() => {
      rerender({ backend: backendC })
    })

    expect(backendC._ctrl.handlers).not.toBeNull()
    expect(result.current.syncStatus).toBe('connected')
  })
})
