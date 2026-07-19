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
  VersionCreatedPayload,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import { act, renderHook } from '@testing-library/react'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock excalidraw before importing the hook — restoreElements must return its input unchanged.
vi.mock('@excalidraw/excalidraw', () => ({
  restoreElements: (els: unknown[]) => els,
  CaptureUpdateAction: { NEVER: 'NEVER' },
  exportToBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  exportToSvg: vi.fn(async () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('data-testid', 'exported-svg')
    return svg
  }),
}))

// eslint-disable-next-line import/first
import { exportToBlob, exportToSvg } from '@excalidraw/excalidraw'
// eslint-disable-next-line import/first
import { useCanvasSync } from './useCanvasSync.js'

// Minimal ExcalidrawImperativeAPI stub — only the methods the hook uses.
function makeApiStub() {
  return {
    updateScene: vi.fn(),
    addFiles: vi.fn(),
    getSceneElements: vi.fn(() => []),
    getAppState: vi.fn(() => ({ scrollX: 0, scrollY: 0, zoom: { value: 1 } })),
    getFiles: vi.fn(() => ({})),
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

function makeControllablePutFileBackend(): CanvasBackend & {
  _ctrl: FakeBackendControl
  _resolvePutFile: () => void
  _rejectPutFile: (err: unknown) => void
} {
  const ctrl: FakeBackendControl = {
    handlers: null,
    disconnectCalled: false,
    pushLocalUpdateCalls: [],
    putFileCalls: [],
  }
  let resolvePending: (() => void) | null = null
  let rejectPending: ((err: unknown) => void) | null = null
  const backend: CanvasBackend & {
    _ctrl: FakeBackendControl
    _resolvePutFile: () => void
    _rejectPutFile: (err: unknown) => void
  } = {
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
    putFile(entries, onSuccess) {
      ctrl.putFileCalls.push(entries as [string, unknown][])
      return new Promise<void>((resolve, reject) => {
        resolvePending = () => {
          for (const [fileId] of entries) onSuccess(fileId)
          resolve()
        }
        rejectPending = reject
      })
    },
    sendClientReady: () => {},
    sendExportResponse: () => {},
    _resolvePutFile: () => resolvePending?.(),
    _rejectPutFile: (err: unknown) => rejectPending?.(err),
  }
  return backend
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

  // Deliberate behavior change (flush-on-teardown): a pending debounced scene
  // edit is now flushed synchronously during teardown cleanup instead of
  // being cancelled and lost. React runs the same cleanup path for a real
  // unmount and a backend switch, so unmount also flushes.
  it('flushes a pending debounced write to the backend on unmount instead of dropping it', async () => {
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

    const callsBeforeChange = backend._ctrl.pushLocalUpdateCalls.length

    const fakeEl = { type: 'rectangle', id: 'el-2', x: 0, y: 0, width: 50, height: 50 }
    act(() => {
      result.current.onChange([fakeEl as never], {} as never, {})
    })

    // No push yet — the 300ms debounce has not elapsed.
    expect(backend._ctrl.pushLocalUpdateCalls.length).toBe(callsBeforeChange)

    unmount()

    // subscribeLocalUpdates fires on a microtask after the flush's doc.commit(),
    // so let it run before asserting the push landed.
    await act(async () => {
      await Promise.resolve()
    })

    // The pending edit must have been flushed and persisted during teardown,
    // not silently dropped by the unmount cleanup.
    expect(backend._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(callsBeforeChange)
  })

  it('flushes a pending debounced scene edit to the outgoing backend A when switching to backend B before the debounce elapses', async () => {
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

    const aCallsBefore = backendA._ctrl.pushLocalUpdateCalls.length

    // Queue a scene edit against A, then switch to B before the 300ms
    // debounce elapses — the classic "draw then immediately switch" flow.
    const fakeEl = { type: 'rectangle', id: 'el-flush', x: 0, y: 0, width: 20, height: 20 }
    act(() => {
      result.current.onChange([fakeEl as never], {} as never, {})
    })

    act(() => {
      rerender({ backend: backendB })
    })

    // subscribeLocalUpdates fires on a microtask after the flush's doc.commit(),
    // so let it run before asserting where the push landed.
    await act(async () => {
      await Promise.resolve()
    })

    // The pending edit must have landed on A during teardown — never dropped,
    // and never routed to B.
    expect(backendA._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(aCallsBefore)
    expect(backendB._ctrl.pushLocalUpdateCalls.length).toBe(0)
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

  // Deliberate behavior change (flush-on-teardown): a pending debounced file
  // upload scheduled against A is no longer dropped when A is superseded by
  // B before the debounce elapses — it is flushed to A during teardown. The
  // invariant that must never regress is that it is never routed to B.
  it('flushes a pending debounced file upload to A (never B) when A is superseded before the debounce elapses, even if cancellation is lost to a timing race', async () => {
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

    // Simulate the real-browser race the finding describes: stub out
    // clearTimeout for the duration of the switch so a raw `.cancel()` call
    // would become a no-op. The teardown now uses `.flush()` instead, which
    // runs the pending call synchronously and clears its own internal
    // pending state regardless of whether the underlying timer was actually
    // cleared, so the queued upload lands on A exactly once even under this
    // race.
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    rerender({ backend: backendB })
    clearTimeoutSpy.mockRestore()

    // Let B finish connecting so its doc is live by the time A's stale timer fires.
    await act(async () => {
      backendB._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
      await vi.advanceTimersByTimeAsync(0)
    })

    // Fire A's un-cancelled underlying timer (a no-op by now: flush already
    // cleared its own pending state during teardown).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    // The queued change was scheduled against A's connection: it must land
    // on A exactly once via the teardown flush, and never on B.
    expect(backendA._ctrl.putFileCalls.length).toBe(1)
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
      _ctrl: {
        handlers: null,
        disconnectCalled: false,
        pushLocalUpdateCalls: [],
        putFileCalls: [],
      },
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

  describe('daemon capability receptors', () => {
    it('delivers onVersionCreated payload to options.onVersionCreated', () => {
      const backend = makeFakeBackend()
      const onVersionCreated = vi.fn()
      renderHook(() => useCanvasSync(backend, { onVersionCreated }))

      // Typed against the z.infer contract (no cast) so payload drift between
      // the test and versionCreatedPayloadSchema fails to compile.
      const payload: VersionCreatedPayload = {
        id: 'v1',
        slug: 'canvas-a',
        createdAt: '2026-01-01T00:00:00.000Z',
        elementCount: 3,
        auto: false,
        hasThumbnail: false,
      }
      act(() => {
        backend._ctrl.handlers!.onVersionCreated(payload)
      })

      expect(onVersionCreated).toHaveBeenCalledWith(payload)
    })

    it('drops a stale-generation onVersionCreated event from a torn-down connection', () => {
      const backendA = makeFakeBackend()
      const backendB = makeFakeBackend()
      const onVersionCreated = vi.fn()
      const { rerender } = renderHook(
        ({ backend }) => useCanvasSync(backend, { onVersionCreated }),
        { initialProps: { backend: backendA as CanvasBackend } },
      )

      const staleHandlers = backendA._ctrl.handlers!
      rerender({ backend: backendB })

      act(() => {
        staleHandlers.onVersionCreated({ versionId: 'stale', createdAt: 1 } as never)
      })

      expect(onVersionCreated).not.toHaveBeenCalled()
    })

    it('passes onHeadChanged payload through to options.onHeadChanged', () => {
      const backend = makeFakeBackend()
      const onHeadChanged = vi.fn()
      renderHook(() => useCanvasSync(backend, { onHeadChanged }))

      const payload = { head: 'branch-1' }
      act(() => {
        backend._ctrl.handlers!.onHeadChanged(payload as never)
      })

      expect(onHeadChanged).toHaveBeenCalledWith(payload)
    })

    it('drops a stale-generation onHeadChanged event from a torn-down connection', () => {
      const backendA = makeFakeBackend()
      const backendB = makeFakeBackend()
      const onHeadChanged = vi.fn()
      const { rerender } = renderHook(({ backend }) => useCanvasSync(backend, { onHeadChanged }), {
        initialProps: { backend: backendA as CanvasBackend },
      })

      const staleHandlers = backendA._ctrl.handlers!
      rerender({ backend: backendB })

      act(() => {
        staleHandlers.onHeadChanged({ head: 'stale' } as never)
      })

      expect(onHeadChanged).not.toHaveBeenCalled()
    })

    it('sets restoreInProgress/restoreLabel on onRestoreStarted and clears them plus local undo on onRestoreComplete', () => {
      const backend = makeFakeBackend()
      const { result } = renderHook(() => useCanvasSync(backend))

      expect(result.current.restoreInProgress).toBe(false)
      expect(result.current.restoreLabel).toBe(null)

      act(() => {
        backend._ctrl.handlers!.onRestoreStarted({ label: 'Restoring v3' } as never)
      })

      expect(result.current.restoreInProgress).toBe(true)
      expect(result.current.restoreLabel).toBe('Restoring v3')

      act(() => {
        backend._ctrl.handlers!.onRestoreComplete()
      })

      expect(result.current.restoreInProgress).toBe(false)
      expect(result.current.restoreLabel).toBe(null)
    })

    it('onRestoreStarted without a label sets restoreLabel to null', () => {
      const backend = makeFakeBackend()
      const { result } = renderHook(() => useCanvasSync(backend))

      act(() => {
        backend._ctrl.handlers!.onRestoreStarted({} as never)
      })

      expect(result.current.restoreInProgress).toBe(true)
      expect(result.current.restoreLabel).toBe(null)
    })

    // Root-cause regression: a connection torn down (backend switch or
    // disconnect) while a restore was in flight must not leave the overlay
    // permanently stuck reporting the old, now-defunct restore.
    it('resets restoreInProgress/restoreLabel when the restoring connection is superseded', () => {
      const backendA = makeFakeBackend()
      const backendB = makeFakeBackend()
      const { result, rerender } = renderHook(({ backend }) => useCanvasSync(backend), {
        initialProps: { backend: backendA as CanvasBackend },
      })

      act(() => {
        backendA._ctrl.handlers!.onRestoreStarted({ label: 'Restoring v3' } as never)
      })
      expect(result.current.restoreInProgress).toBe(true)
      expect(result.current.restoreLabel).toBe('Restoring v3')

      act(() => {
        rerender({ backend: backendB })
      })

      expect(result.current.restoreInProgress).toBe(false)
      expect(result.current.restoreLabel).toBe(null)
    })

    it('resets restoreInProgress/restoreLabel when the restoring connection disconnects to null', () => {
      const backendA = makeFakeBackend()
      const { result, rerender } = renderHook(({ backend }) => useCanvasSync(backend), {
        initialProps: { backend: backendA as CanvasBackend | null },
      })

      act(() => {
        backendA._ctrl.handlers!.onRestoreStarted({ label: 'Restoring v3' } as never)
      })
      expect(result.current.restoreInProgress).toBe(true)

      act(() => {
        rerender({ backend: null })
      })

      expect(result.current.restoreInProgress).toBe(false)
      expect(result.current.restoreLabel).toBe(null)
    })

    it('clearLocalUndo() clears the UndoManager so canUndo becomes false', async () => {
      const backend = makeFakeBackend()
      const api = makeApiStub()
      const { result } = renderHook(() => useCanvasSync(backend))

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      await act(async () => {
        backend._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
        await vi.runAllTimersAsync()
      })

      const fakeEl = { type: 'rectangle', id: 'el-undo', x: 0, y: 0, width: 10, height: 10 }
      act(() => {
        result.current.onChange([fakeEl as never], {} as never, {})
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })

      act(() => {
        result.current.clearLocalUndo()
      })

      // Undo shortcut is a no-op after clearLocalUndo: the scene is untouched.
      const updateSceneCallsBefore = api.updateScene.mock.calls.length
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }),
      )
      expect(api.updateScene.mock.calls.length).toBe(updateSceneCallsBefore)
    })

    it('sets syncStatus to "error" when onAuthError fires', () => {
      const backend = makeFakeBackend()
      const { result } = renderHook(() => useCanvasSync(backend))

      act(() => {
        backend._ctrl.handlers!.onAuthError?.()
      })

      expect(result.current.syncStatus).toBe('error')
    })

    it('drops a stale-generation onAuthError from a torn-down connection', () => {
      const backendA = makeFakeBackend()
      const backendB = makeFakeBackend()
      const { result, rerender } = renderHook(({ backend }) => useCanvasSync(backend), {
        initialProps: { backend: backendA as CanvasBackend },
      })

      const staleHandlers = backendA._ctrl.handlers!
      rerender({ backend: backendB })
      expect(result.current.syncStatus).toBe('connected')

      act(() => {
        staleHandlers.onAuthError?.()
      })

      expect(result.current.syncStatus).toBe('connected')
    })

    it('invokes options.onAuthError in addition to setting syncStatus to "error"', () => {
      const backend = makeFakeBackend()
      const onAuthError = vi.fn()
      const { result } = renderHook(() => useCanvasSync(backend, { onAuthError }))

      act(() => {
        backend._ctrl.handlers!.onAuthError?.()
      })

      expect(onAuthError).toHaveBeenCalledTimes(1)
      expect(result.current.syncStatus).toBe('error')
    })

    it('behaves identically to today when options.onAuthError is omitted', () => {
      const backend = makeFakeBackend()
      const { result } = renderHook(() => useCanvasSync(backend))

      act(() => {
        backend._ctrl.handlers!.onAuthError?.()
      })

      expect(result.current.syncStatus).toBe('error')
    })

    it('calls sendClientReady on connect and again when setExcalidrawAPI fires', () => {
      const backend = makeFakeBackend()
      const api = makeApiStub()
      const sendClientReadySpy = vi.spyOn(backend, 'sendClientReady')

      const { result } = renderHook(() => useCanvasSync(backend))
      expect(sendClientReadySpy).toHaveBeenCalledTimes(1)

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      expect(sendClientReadySpy).toHaveBeenCalledTimes(2)
    })
  })

  describe('onViewportRequest', () => {
    it('mode "fit" with elementIds calls scrollToContent with only the matching elements', () => {
      const backend = makeFakeBackend()
      const api = makeApiStub()
      const elA = { id: 'a' }
      const elB = { id: 'b' }
      ;(api as unknown as { getSceneElements: () => unknown[] }).getSceneElements = () => [elA, elB]
      const { result } = renderHook(() => useCanvasSync(backend))
      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      const scrollToContent = vi.fn()
      ;(api as unknown as { scrollToContent: typeof scrollToContent }).scrollToContent =
        scrollToContent

      act(() => {
        backend._ctrl.handlers!.onViewportRequest({
          mode: 'fit',
          elementIds: ['a'],
        } as never)
      })

      expect(scrollToContent).toHaveBeenCalledWith(
        [elA],
        expect.objectContaining({
          fitToContent: true,
        }),
      )
    })

    it('mode "move" calls updateScene with merged appState', () => {
      const backend = makeFakeBackend()
      const api = makeApiStub()
      const { result } = renderHook(() => useCanvasSync(backend))
      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      act(() => {
        backend._ctrl.handlers!.onViewportRequest({
          mode: 'move',
          scrollX: 10,
          scrollY: 20,
          zoom: 2,
        } as never)
      })

      expect(api.updateScene).toHaveBeenCalledWith(
        expect.objectContaining({
          appState: expect.objectContaining({
            scrollX: 10,
            scrollY: 20,
            zoom: { value: 2 },
          }),
        }),
      )
    })

    it('mode "fit" with elementIds omitted fits the entire scene', () => {
      const backend = makeFakeBackend()
      const api = makeApiStub()
      const elA = { id: 'a' }
      const elB = { id: 'b' }
      ;(api as unknown as { getSceneElements: () => unknown[] }).getSceneElements = () => [elA, elB]
      const { result } = renderHook(() => useCanvasSync(backend))
      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      const scrollToContent = vi.fn()
      ;(api as unknown as { scrollToContent: typeof scrollToContent }).scrollToContent =
        scrollToContent

      act(() => {
        backend._ctrl.handlers!.onViewportRequest({ mode: 'fit' } as never)
      })

      expect(scrollToContent).toHaveBeenCalledWith(
        [elA, elB],
        expect.objectContaining({ fitToContent: true }),
      )
    })

    it('mode "fit" skips scrollToContent when the filtered target list is empty', () => {
      const backend = makeFakeBackend()
      const api = makeApiStub()
      const elA = { id: 'a' }
      ;(api as unknown as { getSceneElements: () => unknown[] }).getSceneElements = () => [elA]
      const { result } = renderHook(() => useCanvasSync(backend))
      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      const scrollToContent = vi.fn()
      ;(api as unknown as { scrollToContent: typeof scrollToContent }).scrollToContent =
        scrollToContent

      act(() => {
        backend._ctrl.handlers!.onViewportRequest({
          mode: 'fit',
          elementIds: ['nonexistent'],
        } as never)
      })

      expect(scrollToContent).not.toHaveBeenCalled()
    })
  })

  describe('onExportRequest', () => {
    it('queues a request before the API is ready and flushes it once setExcalidrawAPI fires', async () => {
      const backend = makeFakeBackend()
      const sendExportResponseSpy = vi.spyOn(backend, 'sendExportResponse')
      const { result } = renderHook(() => useCanvasSync(backend))

      await act(async () => {
        await backend._ctrl.handlers!.onExportRequest({ requestId: 'req-1' } as never)
      })

      expect(sendExportResponseSpy).not.toHaveBeenCalled()

      const api = makeApiStub()
      ;(api as unknown as { getSceneElements: () => unknown[] }).getSceneElements = () => []
      ;(api as unknown as { getFiles: () => unknown }).getFiles = () => ({})
      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      await act(async () => {
        await vi.runAllTimersAsync()
      })

      expect(sendExportResponseSpy).toHaveBeenCalledWith('req-1', expect.any(String))
    })

    // Root-cause regression: onExportRequest awaited handleIncomingExportRequest
    // with no error handling, unlike the equivalent flushPendingExportRequests
    // path a few lines below it (which wraps the same call in .catch). A
    // rejection here (e.g. exportToBlob throwing) must be caught and logged,
    // not left to become an unhandled promise rejection.
    it('catches and logs a rejection from handleIncomingExportRequest instead of throwing', async () => {
      const backend = makeFakeBackend()
      const { result } = renderHook(() => useCanvasSync(backend))
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const api = makeApiStub()
      ;(api as unknown as { getSceneElements: () => unknown[] }).getSceneElements = () => []
      ;(api as unknown as { getFiles: () => unknown }).getFiles = () => ({})
      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      vi.mocked(exportToBlob).mockRejectedValueOnce(new Error('export blew up'))

      await expect(
        act(async () => {
          await backend._ctrl.handlers!.onExportRequest({ requestId: 'req-fail' } as never)
        }),
      ).resolves.not.toThrow()

      try {
        // Routed through app-logger, which prefixes the message with its
        // '[canvas-sync]' name tag.
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[canvas-sync] onExportRequest failed',
          expect.any(Error),
        )
      } finally {
        // Restore even when the assertion throws: a leaked console.error mock
        // would silently swallow diagnostics in every later test in this file.
        consoleErrorSpy.mockRestore()
      }
    })
  })

  describe('putFile ordering', () => {
    it('awaits putFile settlement before doc.commit(), and calls onFileUploadSucceeded on success', async () => {
      const backend = makeControllablePutFileBackend()
      const api = makeApiStub()
      const onFileUploadSucceeded = vi.fn()
      const { result } = renderHook(() => useCanvasSync(backend, { onFileUploadSucceeded }))

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      await act(async () => {
        backend._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
        await vi.runAllTimersAsync()
      })

      const priorPushCalls = backend._ctrl.pushLocalUpdateCalls.length
      const fakeEl = { type: 'image', id: 'img-await', x: 0, y: 0, width: 10, height: 10 }
      const fakeFile = { id: 'file-await', mimeType: 'image/png', dataURL: 'data:x', created: 0 }
      act(() => {
        result.current.onChange([fakeEl as never], {} as never, { 'file-await': fakeFile as never })
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })

      // Commit must not have happened yet: putFile has not settled.
      expect(backend._ctrl.pushLocalUpdateCalls.length).toBe(priorPushCalls)

      await act(async () => {
        backend._resolvePutFile()
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(backend._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(priorPushCalls)
      expect(onFileUploadSucceeded).toHaveBeenCalled()
    })

    it('still commits (non-fatal) when putFile rejects, and calls onFileUploadFailed', async () => {
      const backend = makeControllablePutFileBackend()
      const api = makeApiStub()
      const onFileUploadFailed = vi.fn()
      const { result } = renderHook(() => useCanvasSync(backend, { onFileUploadFailed }))

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      await act(async () => {
        backend._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
        await vi.runAllTimersAsync()
      })

      const priorPushCalls = backend._ctrl.pushLocalUpdateCalls.length
      const fakeEl = { type: 'image', id: 'img-fail', x: 0, y: 0, width: 10, height: 10 }
      const fakeFile = { id: 'file-fail', mimeType: 'image/png', dataURL: 'data:x', created: 0 }
      act(() => {
        result.current.onChange([fakeEl as never], {} as never, { 'file-fail': fakeFile as never })
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })

      await act(async () => {
        backend._rejectPutFile(new Error('upload failed'))
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(backend._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(priorPushCalls)
      expect(onFileUploadFailed).toHaveBeenCalled()
    })

    // Root-cause regression for the then().catch() antipattern: an exception
    // thrown by the caller-supplied onFileUploadSucceeded callback must never
    // be observed as a putFile failure (no onFileUploadFailed call, commit
    // still happens exactly once).
    it('does not treat an exception thrown by onFileUploadSucceeded as a putFile failure', async () => {
      const backend = makeControllablePutFileBackend()
      const api = makeApiStub()
      const onFileUploadFailed = vi.fn()
      const onFileUploadSucceeded = vi.fn(() => {
        throw new Error('consumer callback blew up')
      })
      const { result } = renderHook(() =>
        useCanvasSync(backend, { onFileUploadSucceeded, onFileUploadFailed }),
      )

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      await act(async () => {
        backend._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
        await vi.runAllTimersAsync()
      })

      const priorPushCalls = backend._ctrl.pushLocalUpdateCalls.length
      const fakeEl = { type: 'image', id: 'img-throw', x: 0, y: 0, width: 10, height: 10 }
      const fakeFile = { id: 'file-throw', mimeType: 'image/png', dataURL: 'data:x', created: 0 }
      act(() => {
        result.current.onChange([fakeEl as never], {} as never, { 'file-throw': fakeFile as never })
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })

      await act(async () => {
        backend._resolvePutFile()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(onFileUploadSucceeded).toHaveBeenCalled()
      expect(onFileUploadFailed).not.toHaveBeenCalled()
      // The commit must still happen exactly once despite the thrown callback.
      expect(backend._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(priorPushCalls)
    })

    // Mirrors the onFileUploadSucceeded-throws regression above for the
    // catch(callbackErr) branch on the rejection path: a caller-supplied
    // onFileUploadFailed throwing must never escape and disrupt the
    // .finally() commit.
    it('does not treat an exception thrown by onFileUploadFailed as disrupting the commit', async () => {
      const backend = makeControllablePutFileBackend()
      const api = makeApiStub()
      const onFileUploadFailed = vi.fn(() => {
        throw new Error('consumer callback blew up')
      })
      const { result } = renderHook(() => useCanvasSync(backend, { onFileUploadFailed }))

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      await act(async () => {
        backend._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
        await vi.runAllTimersAsync()
      })

      const priorPushCalls = backend._ctrl.pushLocalUpdateCalls.length
      const fakeEl = { type: 'image', id: 'img-fail-throw', x: 0, y: 0, width: 10, height: 10 }
      const fakeFile = {
        id: 'file-fail-throw',
        mimeType: 'image/png',
        dataURL: 'data:x',
        created: 0,
      }
      act(() => {
        result.current.onChange([fakeEl as never], {} as never, {
          'file-fail-throw': fakeFile as never,
        })
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })

      await act(async () => {
        backend._rejectPutFile(new Error('upload failed'))
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(onFileUploadFailed).toHaveBeenCalled()
      // The commit must still happen exactly once despite the thrown callback.
      expect(backend._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(priorPushCalls)
    })

    // Root-cause regression for the missing-coverage finding: the new
    // generation guard is only supposed to suppress the *callback signal* to
    // a superseded connection's options, never the local Loro commit itself
    // — dropping the commit would silently lose the edit from the document,
    // not merely fail to notify a stale consumer.
    it('still commits the pending edit to A when A is superseded mid-upload, but suppresses the stale onFileUploadSucceeded callback', async () => {
      const backendA = makeControllablePutFileBackend()
      const backendB = makeFakeBackend()
      const api = makeApiStub()
      const onFileUploadSucceeded = vi.fn()

      const { result, rerender } = renderHook(
        ({ backend }) => useCanvasSync(backend, { onFileUploadSucceeded }),
        { initialProps: { backend: backendA as CanvasBackend } },
      )

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      await act(async () => {
        backendA._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
        await vi.runAllTimersAsync()
      })

      const aPushCallsBefore = backendA._ctrl.pushLocalUpdateCalls.length

      const fakeEl = { type: 'image', id: 'img-switch', x: 0, y: 0, width: 10, height: 10 }
      const fakeFile = { id: 'file-switch', mimeType: 'image/png', dataURL: 'data:x', created: 0 }
      act(() => {
        result.current.onChange([fakeEl as never], {} as never, {
          'file-switch': fakeFile as never,
        })
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })

      // putFile is in flight against A. Switch to B before it settles.
      act(() => {
        rerender({ backend: backendB })
      })

      // Now let A's putFile resolve, after the generation has moved on.
      await act(async () => {
        backendA._resolvePutFile()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })

      // The local edit must still be committed and pushed through A's own
      // (now-disconnected) connection — never silently dropped.
      expect(backendA._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(aPushCallsBefore)
      // But the stale connection must not report success to the live options.
      expect(onFileUploadSucceeded).not.toHaveBeenCalled()
      // And it must never be routed to B.
      expect(backendB._ctrl.pushLocalUpdateCalls.length).toBe(0)
    })

    // Root-cause regression: switching to null tears down the session with
    // no successor ever created, so nothing else would ever bump the
    // connection generation for this hook instance. Without the hook itself
    // bumping it on the null transition, A's settling putFile would still
    // match its own myGeneration and wrongly report success for a backend
    // that is no longer attached.
    it('suppresses the stale onFileUploadSucceeded callback when the backend switches to null before the upload settles', async () => {
      const backendA = makeControllablePutFileBackend()
      const api = makeApiStub()
      const onFileUploadSucceeded = vi.fn()

      const { result, rerender } = renderHook(
        ({ backend }) => useCanvasSync(backend, { onFileUploadSucceeded }),
        { initialProps: { backend: backendA as CanvasBackend | null } },
      )

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      await act(async () => {
        backendA._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
        await vi.runAllTimersAsync()
      })

      const fakeEl = { type: 'image', id: 'img-null-switch', x: 0, y: 0, width: 10, height: 10 }
      const fakeFile = {
        id: 'file-null-switch',
        mimeType: 'image/png',
        dataURL: 'data:x',
        created: 0,
      }
      act(() => {
        result.current.onChange([fakeEl as never], {} as never, {
          'file-null-switch': fakeFile as never,
        })
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })

      // putFile is in flight against A. Switch to null before it settles.
      act(() => {
        rerender({ backend: null })
      })

      await act(async () => {
        backendA._resolvePutFile()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(onFileUploadSucceeded).not.toHaveBeenCalled()
    })

    // Root-cause regression: A's onSuccess callback fires after the
    // connection has already switched to B. It must record the upload only
    // against A's own (now-detached) uploaded-file set, never against B's
    // live set — otherwise B would wrongly believe it already has the file
    // and skip uploading it on a later change with the same fileId.
    it("does not mark a file as uploaded on the new backend when the old backend's upload settles after a switch", async () => {
      const backendA = makeControllablePutFileBackend()
      const backendB = makeFakeBackend()
      const api = makeApiStub()

      const { result, rerender } = renderHook(({ backend }) => useCanvasSync(backend, {}), {
        initialProps: { backend: backendA as CanvasBackend },
      })

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      await act(async () => {
        backendA._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
        await vi.runAllTimersAsync()
      })

      const fakeEl = { type: 'image', id: 'img-shared', x: 0, y: 0, width: 10, height: 10 }
      const fakeFile = { id: 'file-shared', mimeType: 'image/png', dataURL: 'data:x', created: 0 }
      act(() => {
        result.current.onChange([fakeEl as never], {} as never, {
          'file-shared': fakeFile as never,
        })
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })

      // Switch to B before A's putFile settles.
      act(() => {
        rerender({ backend: backendB })
      })

      await act(async () => {
        backendB._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
        await vi.runAllTimersAsync()
      })

      // Now let A's putFile resolve, well after the generation moved on.
      await act(async () => {
        backendA._resolvePutFile()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })

      // A later change on B with the same fileId must still be uploaded to
      // B — the stale A success must not have marked it uploaded on B.
      act(() => {
        result.current.onChange([fakeEl as never], {} as never, {
          'file-shared': fakeFile as never,
        })
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
      })

      expect(backendB._ctrl.putFileCalls.length).toBeGreaterThan(0)
    })

    // Root-cause regression: onSceneChange used to gate doc.commit() behind
    // an async putFile().finally() only for firings with new files. Firings
    // are not otherwise serialized against each other, so a later, file-less
    // firing could commit synchronously (out of order) while an earlier
    // firing's putFile was still pending. When that earlier firing's commit
    // finally ran, it used its own stale `elements` snapshot — silently
    // tombstoning any element the later firing had added in the meantime.
    it('serializes commits across firings so a slow file-upload commit never reverts a faster, later file-less commit', async () => {
      const backend = makeControllablePutFileBackend()
      const api = makeApiStub()
      const { result } = renderHook(() => useCanvasSync(backend))

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      await act(async () => {
        backend._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
        await vi.runAllTimersAsync()
      })

      const elA = {
        type: 'image',
        id: 'el-a',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        fileId: 'file-a',
      }
      const fileA = { id: 'file-a', mimeType: 'image/png', dataURL: 'data:x', created: 0 }

      // Firing A: a new image element with a file upload that stays pending
      // until _resolvePutFile() is called below.
      act(() => {
        result.current.onChange([elA as never], {} as never, { 'file-a': fileA as never })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      expect(backend._ctrl.putFileCalls.length).toBe(1)

      // Firing B: a later, file-less edit adding a second element. No new
      // files means this firing has nothing to await, so it would otherwise
      // race ahead of A's still-pending commit.
      const elB = { type: 'rectangle', id: 'el-b', x: 0, y: 0, width: 5, height: 5 }
      act(() => {
        result.current.onChange([elA as never, elB as never], {} as never, {})
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })

      // Now let A's stale putFile settle.
      await act(async () => {
        backend._resolvePutFile()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })

      const finalDoc = new LoroDoc()
      for (const bytes of backend._ctrl.pushLocalUpdateCalls) {
        finalDoc.import(bytes)
      }
      const finalElements = finalDoc.getMovableList('elements').toJSON() as Array<{
        id: string
        isDeleted?: boolean
      }>
      const elBFinal = finalElements.find((e) => e.id === 'el-b')
      expect(elBFinal).toBeDefined()
      expect(elBFinal?.isDeleted).not.toBe(true)
    })

    it('a firing whose commit throws does not poison the chain — later firings still commit', async () => {
      const backend = makeFakeBackend()
      const api = makeApiStub()
      const { result } = renderHook(() => useCanvasSync(backend))

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })
      await act(async () => {
        backend._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
        await vi.runAllTimersAsync()
      })
      const callsBefore = backend._ctrl.pushLocalUpdateCalls.length

      // Firing 1: an element whose property enumeration throws mid-commit.
      // Without a guard this rejects the commit chain, and every later firing
      // chained via .then() is silently skipped for the rest of the session.
      const poison = new Proxy(
        { type: 'rectangle', id: 'el-poison', x: 0, y: 0, width: 1, height: 1 },
        {
          ownKeys() {
            throw new Error('poisoned element')
          },
        },
      )
      act(() => {
        result.current.onChange([poison as never], {} as never, {})
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })

      // Firing 2: a normal element. Its commit must still land.
      const elB = { type: 'rectangle', id: 'el-after-poison', x: 0, y: 0, width: 5, height: 5 }
      act(() => {
        result.current.onChange([elB as never], {} as never, {})
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })

      expect(backend._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(callsBefore)
      const finalDoc = new LoroDoc()
      for (const bytes of backend._ctrl.pushLocalUpdateCalls) {
        finalDoc.import(bytes)
      }
      const ids = (finalDoc.getMovableList('elements').toJSON() as Array<{ id: string }>).map(
        (e) => e.id,
      )
      expect(ids).toContain('el-after-poison')
    })

    it('a putFile that never settles stops blocking the chain after the upload timeout', async () => {
      const backend = makeControllablePutFileBackend()
      const api = makeApiStub()
      const { result } = renderHook(() => useCanvasSync(backend))

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })
      await act(async () => {
        backend._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
        await vi.runAllTimersAsync()
      })

      // Firing A: image upload that never settles (hung network).
      const elA = { type: 'image', id: 'el-hang', x: 0, y: 0, width: 10, height: 10, fileId: 'f-h' }
      const fileA = { id: 'f-h', mimeType: 'image/png', dataURL: 'data:x', created: 0 }
      act(() => {
        result.current.onChange([elA as never], {} as never, { 'f-h': fileA as never })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })
      expect(backend._ctrl.putFileCalls.length).toBe(1)

      // Firing B: file-less edit queued behind A's hung upload.
      const elB = { type: 'rectangle', id: 'el-after-hang', x: 0, y: 0, width: 5, height: 5 }
      act(() => {
        result.current.onChange([elA as never, elB as never], {} as never, {})
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })

      // Never resolve the upload; advance past the upload timeout instead.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })

      const finalDoc = new LoroDoc()
      for (const bytes of backend._ctrl.pushLocalUpdateCalls) {
        finalDoc.import(bytes)
      }
      const ids = (finalDoc.getMovableList('elements').toJSON() as Array<{ id: string }>).map(
        (e) => e.id,
      )
      expect(ids).toContain('el-after-hang')
    })
  })

  describe('stale-generation drop coverage for restore/viewport/export handlers', () => {
    it('drops a stale-generation onRestoreStarted/onRestoreComplete event from a torn-down connection', () => {
      const backendA = makeFakeBackend()
      const backendB = makeFakeBackend()
      const { result, rerender } = renderHook(({ backend }) => useCanvasSync(backend), {
        initialProps: { backend: backendA as CanvasBackend },
      })

      const staleHandlers = backendA._ctrl.handlers!
      rerender({ backend: backendB })

      act(() => {
        staleHandlers.onRestoreStarted({ label: 'stale restore' } as never)
      })
      expect(result.current.restoreInProgress).toBe(false)
      expect(result.current.restoreLabel).toBe(null)

      // Also verify onRestoreComplete is dropped: put the live connection into
      // a restoring state via a fresh (non-stale) event, then confirm the
      // stale handler cannot clear it.
      act(() => {
        backendB._ctrl.handlers!.onRestoreStarted({ label: 'live restore' } as never)
      })
      expect(result.current.restoreInProgress).toBe(true)

      act(() => {
        staleHandlers.onRestoreComplete()
      })
      expect(result.current.restoreInProgress).toBe(true)
      expect(result.current.restoreLabel).toBe('live restore')
    })

    it('drops a stale-generation onViewportRequest event from a torn-down connection', () => {
      const backendA = makeFakeBackend()
      const backendB = makeFakeBackend()
      const api = makeApiStub()
      const scrollToContent = vi.fn()
      ;(api as unknown as { scrollToContent: typeof scrollToContent }).scrollToContent =
        scrollToContent
      ;(api as unknown as { getSceneElements: () => unknown[] }).getSceneElements = () => [
        { id: 'a' },
      ]

      const { result, rerender } = renderHook(({ backend }) => useCanvasSync(backend), {
        initialProps: { backend: backendA as CanvasBackend },
      })
      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      const staleHandlers = backendA._ctrl.handlers!
      rerender({ backend: backendB })

      act(() => {
        staleHandlers.onViewportRequest({ mode: 'fit', elementIds: ['a'] } as never)
      })

      expect(scrollToContent).not.toHaveBeenCalled()
    })

    it('drops a stale-generation onExportRequest event from a torn-down connection', async () => {
      const backendA = makeFakeBackend()
      const backendB = makeFakeBackend()
      const sendExportResponseSpyA = vi.spyOn(backendA, 'sendExportResponse')

      const { rerender } = renderHook(({ backend }) => useCanvasSync(backend), {
        initialProps: { backend: backendA as CanvasBackend },
      })

      const staleHandlers = backendA._ctrl.handlers!
      rerender({ backend: backendB })

      await act(async () => {
        await staleHandlers.onExportRequest({ requestId: 'stale-req' } as never)
      })

      expect(sendExportResponseSpyA).not.toHaveBeenCalled()
    })
  })

  describe('export_response routing after a backend switch', () => {
    // Root-cause regression: an in-flight export must be answered on the
    // backend that requested it, never on whatever backend happens to be
    // live by the time the (async) export/base64 work finishes.
    it('routes the export response to the requesting backend, not a backend switched in mid-export', async () => {
      const backendA = makeFakeBackend()
      const backendB = makeFakeBackend()
      const sendExportResponseSpyA = vi.spyOn(backendA, 'sendExportResponse')
      const sendExportResponseSpyB = vi.spyOn(backendB, 'sendExportResponse')
      const api = makeApiStub()
      ;(api as unknown as { getSceneElements: () => unknown[] }).getSceneElements = () => []
      ;(api as unknown as { getFiles: () => unknown }).getFiles = () => ({})

      const { result, rerender } = renderHook(({ backend }) => useCanvasSync(backend), {
        initialProps: { backend: backendA as CanvasBackend },
      })

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      // Fire the export request against A, then switch to B before the
      // (mocked, but still async) export/base64 conversion resolves. The
      // promise is intentionally not awaited directly here — blobToBase64
      // uses a real FileReader, which needs fake timers advanced via
      // runAllTimersAsync to ever settle.
      void backendA._ctrl.handlers!.onExportRequest({ requestId: 'req-a' } as never)

      act(() => {
        rerender({ backend: backendB })
      })

      await act(async () => {
        await vi.runAllTimersAsync()
      })

      expect(sendExportResponseSpyA).toHaveBeenCalledWith('req-a', expect.any(String))
      expect(sendExportResponseSpyB).not.toHaveBeenCalled()
    })
  })

  describe('identity events', () => {
    const identity = { workspaceId: 'ws-1', slug: 'canvas-a' }

    function listenFor(eventName: string): { calls: CustomEvent[] } {
      const state = { calls: [] as CustomEvent[] }
      window.addEventListener(eventName, ((e: Event) => {
        state.calls.push(e as CustomEvent)
      }) as EventListener)
      return state
    }

    it('does not dispatch doc_changed for the initial snapshot import', async () => {
      const backend = makeFakeBackend()
      const docChanged = listenFor('excalidraw:doc_changed')
      renderHook(() => useCanvasSync(backend, { identity }))

      await act(async () => {
        backend._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
        await vi.runAllTimersAsync()
      })

      expect(docChanged.calls).toHaveLength(0)
    })

    it('dispatches doc_changed with identity detail on a remote update after the snapshot', async () => {
      const backend = makeFakeBackend()
      const docChanged = listenFor('excalidraw:doc_changed')
      renderHook(() => useCanvasSync(backend, { identity }))

      await act(async () => {
        backend._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
        await vi.runAllTimersAsync()
      })

      const remoteDoc = new LoroDoc()
      remoteDoc.getMovableList('elements').insertContainer(0, new LoroMap())
      remoteDoc.commit()
      const bytes = remoteDoc.export({ mode: 'update' })
      await act(async () => {
        backend._ctrl.handlers!.onRemoteUpdate(bytes)
        await vi.runAllTimersAsync()
      })

      expect(docChanged.calls).toHaveLength(1)
      expect(docChanged.calls[0].detail).toEqual(identity)
    })

    it('dispatches doc_changed on a local scene edit commit', async () => {
      const backend = makeFakeBackend()
      const api = makeApiStub()
      const docChanged = listenFor('excalidraw:doc_changed')
      const { result } = renderHook(() => useCanvasSync(backend, { identity }))

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })
      await act(async () => {
        backend._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
        await vi.runAllTimersAsync()
      })

      const el = { type: 'rectangle', id: 'el-1', x: 0, y: 0, width: 5, height: 5 }
      act(() => {
        result.current.onChange([el as never], {} as never, {})
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300)
      })

      expect(docChanged.calls.length).toBeGreaterThan(0)
      expect(docChanged.calls[docChanged.calls.length - 1].detail).toEqual(identity)
    })

    it('dispatches version_saved with identity detail when a version_created broadcast arrives', () => {
      const backend = makeFakeBackend()
      const versionSaved = listenFor('excalidraw:version_saved')
      renderHook(() => useCanvasSync(backend, { identity }))

      const payload: VersionCreatedPayload = {
        id: 'v1',
        slug: 'canvas-a',
        createdAt: '2026-01-01T00:00:00.000Z',
        elementCount: 3,
        auto: false,
        hasThumbnail: false,
      }
      act(() => {
        backend._ctrl.handlers!.onVersionCreated(payload)
      })

      expect(versionSaved.calls).toHaveLength(1)
      expect(versionSaved.calls[0].detail).toEqual(identity)
    })

    it('does not dispatch any identity events when identity is absent', async () => {
      const backend = makeFakeBackend()
      const docChanged = listenFor('excalidraw:doc_changed')
      const versionSaved = listenFor('excalidraw:version_saved')
      renderHook(() => useCanvasSync(backend))

      await act(async () => {
        backend._ctrl.handlers!.onSnapshot(makeEmptyLoroSnapshot())
        await vi.runAllTimersAsync()
      })
      const remoteDoc = new LoroDoc()
      await act(async () => {
        backend._ctrl.handlers!.onRemoteUpdate(remoteDoc.export({ mode: 'update' }))
        await vi.runAllTimersAsync()
      })
      act(() => {
        backend._ctrl.handlers!.onVersionCreated({
          id: 'v1',
          slug: 'canvas-a',
          createdAt: '2026-01-01T00:00:00.000Z',
          elementCount: 0,
          auto: false,
          hasThumbnail: false,
        })
      })

      expect(docChanged.calls).toHaveLength(0)
      expect(versionSaved.calls).toHaveLength(0)
    })

    it('does not dispatch any identity events when identity is partial', () => {
      const backend = makeFakeBackend()
      const versionSaved = listenFor('excalidraw:version_saved')
      renderHook(() => useCanvasSync(backend, { identity: { workspaceId: 'ws-1' } as never }))

      act(() => {
        backend._ctrl.handlers!.onVersionCreated({
          id: 'v1',
          slug: 'canvas-a',
          createdAt: '2026-01-01T00:00:00.000Z',
          elementCount: 0,
          auto: false,
          hasThumbnail: false,
        })
      })

      expect(versionSaved.calls).toHaveLength(0)
    })

    it('changing the identity option between renders does not force a backend reconnect', () => {
      const backend = makeFakeBackend()
      const connectSpy = vi.spyOn(backend, 'connect')
      const { rerender } = renderHook(({ id }) => useCanvasSync(backend, { identity: id }), {
        initialProps: { id: identity },
      })

      rerender({ id: { workspaceId: 'ws-1', slug: 'canvas-b' } })
      rerender({ id: { workspaceId: 'ws-2', slug: 'canvas-c' } })

      expect(connectSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('exportScene', () => {
    beforeEach(() => {
      vi.mocked(exportToBlob).mockClear()
      vi.mocked(exportToSvg).mockClear()
    })

    it('returns null when no excalidraw API is registered yet', async () => {
      const backend = makeFakeBackend()
      const { result } = renderHook(() => useCanvasSync(backend))

      const blob = await result.current.exportScene('png')

      expect(blob).toBeNull()
      expect(exportToBlob).not.toHaveBeenCalled()
    })

    it('exports a PNG blob via exportToBlob using the live scene', async () => {
      const backend = makeFakeBackend()
      const api = makeApiStub()
      const { result } = renderHook(() => useCanvasSync(backend))

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      const blob = await result.current.exportScene('png')

      expect(exportToBlob).toHaveBeenCalledWith(
        expect.objectContaining({
          elements: api.getSceneElements(),
          files: api.getFiles(),
        }),
      )
      expect(blob).not.toBeNull()
      expect(blob!.type).toBe('image/png')
    })

    it("exports an SVG blob by serializing exportToSvg's SVGSVGElement", async () => {
      const backend = makeFakeBackend()
      const api = makeApiStub()
      const { result } = renderHook(() => useCanvasSync(backend))

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      const blob = await result.current.exportScene('svg')

      expect(exportToSvg).toHaveBeenCalled()
      expect(blob).not.toBeNull()
      expect(blob!.type).toBe('image/svg+xml')
      const text = await blob!.text()
      expect(text).toContain('data-testid="exported-svg"')
    })

    it("rejects a direct 'json' call instead of silently returning an SVG blob", async () => {
      const backend = makeFakeBackend()
      const api = makeApiStub()
      const { result } = renderHook(() => useCanvasSync(backend))

      act(() => {
        result.current.setExcalidrawAPI(api as never)
      })

      await expect(result.current.exportScene('json')).rejects.toThrow()
      expect(exportToSvg).not.toHaveBeenCalled()
    })
  })
})
