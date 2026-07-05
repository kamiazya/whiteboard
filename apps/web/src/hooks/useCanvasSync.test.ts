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
import { LoroDoc, LoroMap } from 'loro-crdt'
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
  putFileCalls: [string, unknown][][]
}

function makeFakeBackend(): CanvasBackend & { _ctrl: FakeBackendControl } {
  const ctrl: FakeBackendControl = {
    handlers: null,
    disconnectCalled: false,
    pushLocalUpdateCalls: [],
    putFileCalls: [],
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
    putFile: async (entries) => {
      ctrl.putFileCalls.push(entries as [string, unknown][])
    },
    sendClientReady: () => {},
    sendExportResponse: () => {},
  }
  return backend
}

function makeEmptyLoroSnapshot(): Uint8Array {
  const doc = new LoroDoc()
  return doc.export({ mode: 'snapshot' })
}

// Builds a snapshot containing a single image element referencing fileId,
// so onSnapshot triggers a bk.getFile(fileId) fetch inside applyLoroToExcalidraw.
function makeLoroSnapshotWithImage(fileId: string): Uint8Array {
  const doc = new LoroDoc()
  const list = doc.getMovableList('elements')
  const map = list.insertContainer(0, new LoroMap())
  map.set('id', 'img-1')
  map.set('type', 'image')
  map.set('x', 0)
  map.set('y', 0)
  map.set('width', 10)
  map.set('height', 10)
  map.set('fileId', fileId)
  doc.commit()
  return doc.export({ mode: 'snapshot' })
}

function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
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

  it('undo/redo keyboard shortcuts are safe no-ops when backend is null', () => {
    const api = makeApiStub()

    // Register the excalidraw API so the keydown handler has something to
    // (not) act on — the undo/redo guard should short-circuit before it does.
    const { result } = renderHook(({ backend }) => useCanvasSync(backend), {
      initialProps: { backend: null as CanvasBackend | null },
    })
    act(() => {
      result.current.setExcalidrawAPI(api as never)
    })

    expect(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }),
      )
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'z',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    }).not.toThrow()

    // Neither shortcut had a doc/undoManager to act on, so the scene is untouched.
    expect(api.updateScene).not.toHaveBeenCalled()
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

  it('drops a pending debounced file upload scheduled against a since-superseded backend, even if its cancellation is lost to a timing race', async () => {
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

    // Queue a scene change with a new file against backend A. The debounce
    // schedules a real (fake-clock) timer for this call's args.
    const fakeEl = { type: 'image', id: 'img-x', x: 0, y: 0, width: 10, height: 10 }
    const fakeFile = { id: 'file-x', mimeType: 'image/png', dataURL: 'data:x', created: 0 }
    act(() => {
      result.current.onChange([fakeEl as never], {} as never, { 'file-x': fakeFile as never })
    })

    // Simulate the real-browser race the finding describes: the passive
    // effect's own `onSceneChange.cancel()` call races the already-elapsing
    // timer and loses, so A's pending flush survives the switch to B. Stub
    // out clearTimeout for the duration of the switch so `.cancel()` becomes
    // a no-op without touching any of this hook's own logic.
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    rerender({ backend: backendB })
    clearTimeoutSpy.mockRestore()

    // Let B finish connecting so its doc is live by the time A's stale timer fires.
    await act(async () => {
      backendB._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
      await vi.advanceTimersByTimeAsync(0)
    })

    // Fire A's un-cancelled timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    // The queued change was scheduled against A's connection; once
    // superseded it must be dropped entirely rather than uploaded to B.
    expect(backendA._ctrl.putFileCalls.length).toBe(0)
    expect(backendB._ctrl.putFileCalls.length).toBe(0)
  })

  it("does not let a stale getFile fetch from a torn-down backend pollute the new backend's file cache", async () => {
    const api = makeApiStub()
    const fileId = 'shared-file'

    // backendA's getFile never resolves during this test until we do so
    // manually, simulating an in-flight fetch that outlives the backend swap.
    const deferredOld = makeDeferred<Blob>()
    const backendA = makeFakeBackend()
    backendA.getFile = async () => deferredOld.promise

    // backendB resolves immediately with different content.
    const backendB = makeFakeBackend()
    backendB.getFile = async () => new Blob(['new-content'], { type: 'text/plain' })

    const { result, rerender } = renderHook(({ backend }) => useCanvasSync(backend), {
      initialProps: { backend: backendA as CanvasBackend },
    })

    act(() => {
      result.current.setExcalidrawAPI(api as never)
    })

    // Snapshot from A references fileId, kicking off backendA.getFile(fileId)
    // — left pending (deferredOld is not resolved yet).
    await act(async () => {
      backendA._ctrl.handlers!.onSnapshot(makeLoroSnapshotWithImage(fileId))
      await vi.advanceTimersByTimeAsync(0)
    })

    // Switch to backend B before A's fetch resolves. This resets the shared
    // file cache and bumps the apply generation, tearing down A's connection.
    rerender({ backend: backendB })

    // Snapshot from B references the same fileId; backendB.getFile resolves
    // immediately with fresh content.
    await act(async () => {
      backendB._ctrl.handlers!.onSnapshot(makeLoroSnapshotWithImage(fileId))
      await vi.runAllTimersAsync()
    })

    const addFilesCallsBeforeStaleResolve = api.addFiles.mock.calls.length
    expect(addFilesCallsBeforeStaleResolve).toBeGreaterThan(0)

    // Now let A's stale fetch resolve with old content — after the switch.
    await act(async () => {
      deferredOld.resolve(new Blob(['old-content'], { type: 'text/plain' }))
      await vi.runAllTimersAsync()
    })

    // Force another apply on B (subsequent remote update) so any cache
    // pollution from the stale write would surface in a fresh addFiles call.
    await act(async () => {
      backendB._ctrl.handlers!.onRemoteUpdate(makeLoroSnapshotWithImage(fileId))
      await vi.runAllTimersAsync()
    })

    const allDataUrls = api.addFiles.mock.calls.flatMap((call) =>
      (call[0] as { dataURL: string }[]).map((f) => f.dataURL),
    )
    const hasOldContent = allDataUrls.some((url) => url.includes(btoa('old-content')))
    expect(hasOldContent).toBe(false)
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
      _ctrl: { handlers: null, disconnectCalled: false, pushLocalUpdateCalls: [], putFileCalls: [] },
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
