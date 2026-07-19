/**
 * canvas-sync-session unit tests — jsdom layer.
 *
 * @excalidraw/excalidraw is mocked because it loads roughjs native bindings
 * that are not available in jsdom. Exercises the extracted non-React
 * connection module directly with a fake CanvasBackend, independent of
 * useCanvasSync/React.
 */

import type {
  CanvasBackend,
  CanvasBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@excalidraw/excalidraw', () => ({
  restoreElements: (els: unknown[]) => els,
  CaptureUpdateAction: { NEVER: 'NEVER' },
  exportToBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}))

// eslint-disable-next-line import/first
import {
  createCanvasSyncSession,
  createGenerationCounters,
  type SessionDeps,
} from './canvas-sync-session.js'

function makeEmptySnapshot(): Uint8Array {
  return new LoroDoc().export({ mode: 'snapshot' })
}

function makeDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// Drains several microtask turns with real awaits. dispose()'s drain phase
// schedules the flush-triggered push and the deferred disconnect across a few
// microtask turns; fake timers do not control microtasks, so a generous number
// of turns is the reliable way to let that chain settle.
async function flushMicrotasks(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve()
  }
}

// Builds a snapshot containing a single image element referencing fileId, so
// onSnapshot triggers a backend.getFile(fileId) fetch inside applyLoroToExcalidraw.
function makeSnapshotWithImage(fileId: string): Uint8Array {
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
  return {
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
    putFile: async (entries, onSuccess) => {
      for (const [fileId] of entries) onSuccess(fileId)
    },
    sendClientReady: () => {},
    sendExportResponse: () => {},
  }
}

function makeDeps(overrides: Partial<SessionDeps> = {}): SessionDeps {
  return {
    getExcalidrawAPI: () => null,
    getOptions: () => ({}),
    onStatusChange: vi.fn(),
    onRestoreChange: vi.fn(),
    dispatchIdentityEvent: vi.fn(),
    generations: createGenerationCounters(),
    ...overrides,
  }
}

describe('createCanvasSyncSession', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('connects and reports "connected" via the injected status callback, then sends client-ready', () => {
    const backend = makeFakeBackend()
    const sendReadySpy = vi.spyOn(backend, 'sendClientReady')
    const onStatusChange = vi.fn()
    const session = createCanvasSyncSession(backend, makeDeps({ onStatusChange }))

    session.connect()

    expect(onStatusChange).toHaveBeenCalledWith('connected')
    expect(sendReadySpy).toHaveBeenCalledTimes(1)
  })

  it('dispose() flushes a pending debounced edit into this session before disconnecting', async () => {
    const backend = makeFakeBackend()
    const session = createCanvasSyncSession(backend, makeDeps())
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeEmptySnapshot())

    session.onChange([{ id: 'el-1', type: 'rectangle' } as never], {})

    // Debounce (300ms) has not fired yet.
    expect(backend._ctrl.pushLocalUpdateCalls).toHaveLength(0)

    session.dispose()

    // flush() runs the commit synchronously; the resulting
    // subscribeLocalUpdates push fires on a microtask, and dispose()'s drain
    // phase defers backend.disconnect() a few more microtask turns behind
    // that push — draining several turns covers both.
    await flushMicrotasks()
    expect(backend._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(0)
    expect(backend._ctrl.disconnectCalled).toBe(true)
  })

  it('mutation check: an isStale() guard on the subscribeLocalUpdates callback would drop the post-dispose flush push', async () => {
    // This test intentionally re-implements the callback with the guard the
    // production code deliberately omits, to prove the omission matters —
    // it does not touch production code, but documents the exact failure
    // mode the comment in createCanvasSyncSession warns about.
    let disposed = false
    const pushed: Uint8Array[] = []
    function guardedSubscriber(update: Uint8Array): void {
      if (disposed) return
      pushed.push(update)
    }
    // Simulate: flush() runs synchronously (doc.commit fires here), then
    // disposed flips true, then the subscriber's microtask runs afterward.
    const microtaskUpdate = new Uint8Array([1, 2, 3])
    const fireOnMicrotask = Promise.resolve().then(() => guardedSubscriber(microtaskUpdate))
    disposed = true
    await fireOnMicrotask
    expect(pushed).toHaveLength(0) // guarded version loses the edit — the bug this test protects against
  })

  it('unmount-only disposal: a settling putFile still invokes the (latest-options) success callback', async () => {
    let resolvePutFile: (() => void) | null = null
    const backend: CanvasBackend & { _ctrl: FakeBackendControl } = {
      ...makeFakeBackend(),
      putFile: (entries, onSuccess) =>
        new Promise((resolve) => {
          resolvePutFile = () => {
            for (const [fileId] of entries) onSuccess(fileId)
            resolve()
          }
        }),
    }
    const onFileUploadSucceeded = vi.fn()
    const session = createCanvasSyncSession(
      backend,
      makeDeps({ getOptions: () => ({ onFileUploadSucceeded }) }),
    )
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeEmptySnapshot())

    session.onChange([], { 'file-1': { id: 'file-1', dataURL: 'data:x' } as never })
    await vi.advanceTimersByTimeAsync(300)

    session.dispose() // unmount-only — no successor session, no generation bump

    resolvePutFile!()
    await vi.waitFor(() => expect(onFileUploadSucceeded).toHaveBeenCalledTimes(1))
  })

  it("supersession disposal: a new session bumping the connection generation suppresses the old session's upload signal", async () => {
    let resolvePutFile: (() => void) | null = null
    const backendA: CanvasBackend & { _ctrl: FakeBackendControl } = {
      ...makeFakeBackend(),
      putFile: (entries, onSuccess) =>
        new Promise((resolve) => {
          resolvePutFile = () => {
            for (const [fileId] of entries) onSuccess(fileId)
            resolve()
          }
        }),
    }
    const generations = createGenerationCounters()
    const onFileUploadSucceeded = vi.fn()
    const sessionA = createCanvasSyncSession(
      backendA,
      makeDeps({ generations, getOptions: () => ({ onFileUploadSucceeded }) }),
    )
    sessionA.connect()
    backendA._ctrl.handlers!.onSnapshot(makeEmptySnapshot())
    sessionA.onChange([], { 'file-1': { id: 'file-1', dataURL: 'data:x' } as never })
    await vi.advanceTimersByTimeAsync(300)

    sessionA.dispose()

    // A new session supersedes A — bumps connectionGeneration.
    const backendB = makeFakeBackend()
    const sessionB = createCanvasSyncSession(backendB, makeDeps({ generations }))
    sessionB.connect()

    resolvePutFile!()
    await Promise.resolve()
    await Promise.resolve()

    expect(onFileUploadSucceeded).not.toHaveBeenCalled()
  })

  it('MID-DEBOUNCE SWAP: a firing scheduled before dispose commits into its own session, never a superseding one', async () => {
    const backendA = makeFakeBackend()
    const backendB = makeFakeBackend()
    const generations = createGenerationCounters()
    const sessionA = createCanvasSyncSession(backendA, makeDeps({ generations }))
    sessionA.connect()
    backendA._ctrl.handlers!.onSnapshot(makeEmptySnapshot())

    sessionA.onChange([{ id: 'el-1', type: 'rectangle' } as never], {})

    // Before the 300ms debounce fires, session A is disposed and a new
    // session B is constructed against a different backend/doc.
    sessionA.dispose()
    const sessionB = createCanvasSyncSession(backendB, makeDeps({ generations }))
    sessionB.connect()
    backendB._ctrl.handlers!.onSnapshot(makeEmptySnapshot())

    await vi.advanceTimersByTimeAsync(300)
    await Promise.resolve()

    // A's flush (triggered by its own dispose) already pushed into A;
    // no further scheduled timer exists for A since flush cancels the timer.
    expect(backendA._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(0)
    expect(backendB._ctrl.pushLocalUpdateCalls).toHaveLength(0)
  })

  it('onApiReady reapplies the doc, re-sends clientReady, and flushes pending export requests, even with no doc yet', async () => {
    const backend = makeFakeBackend()
    const sendReadySpy = vi.spyOn(backend, 'sendClientReady')
    const api = {
      addFiles: vi.fn(),
      updateScene: vi.fn(),
      getSceneElements: vi.fn(() => []),
      getAppState: vi.fn(() => ({})),
      getFiles: vi.fn(() => ({})),
    }
    const session = createCanvasSyncSession(
      backend,
      makeDeps({ getExcalidrawAPI: () => api as never }),
    )
    session.connect()

    // No snapshot has landed yet — onApiReady must still send clientReady.
    session.onApiReady()
    expect(sendReadySpy).toHaveBeenCalledTimes(2) // once on connect, once on apiReady

    backend._ctrl.handlers!.onSnapshot(makeEmptySnapshot())
    await Promise.resolve()
    await Promise.resolve()
    api.updateScene.mockClear()
    session.onApiReady()
    await Promise.resolve()
    await Promise.resolve()
    expect(api.updateScene).toHaveBeenCalled()
    expect(sendReadySpy).toHaveBeenCalledTimes(3)
  })

  it('restore lifecycle drives the injected restore callback and clears undo on complete', () => {
    const backend = makeFakeBackend()
    const onRestoreChange = vi.fn()
    const session = createCanvasSyncSession(backend, makeDeps({ onRestoreChange }))
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeEmptySnapshot())

    backend._ctrl.handlers!.onRestoreStarted({ label: 'v3' } as never)
    expect(onRestoreChange).toHaveBeenCalledWith(true, 'v3')

    backend._ctrl.handlers!.onRestoreComplete()
    expect(onRestoreChange).toHaveBeenCalledWith(false, null)
  })

  // Root-cause regression: a delayed getFile() resolving after this session
  // was torn down (backend switched to null, or a successor's own snapshot
  // has not arrived yet) must never write stale content into the
  // Excalidraw API. Prior to bumping the apply generation unconditionally in
  // dispose(), this generation match only broke when *another* session's own
  // applyLoroToExcalidraw call happened to run first — a torn-down session
  // with no immediate successor slipped through.
  it('a pending getFile fetch from a torn-down session with no successor never applies stale content', async () => {
    const deferred = makeDeferred<Blob>()
    const backend: CanvasBackend & { _ctrl: FakeBackendControl } = {
      ...makeFakeBackend(),
      getFile: async () => deferred.promise,
    }
    const api = {
      addFiles: vi.fn(),
      updateScene: vi.fn(),
      getSceneElements: vi.fn(() => []),
      getAppState: vi.fn(() => ({})),
      getFiles: vi.fn(() => ({})),
    }
    const session = createCanvasSyncSession(
      backend,
      makeDeps({ getExcalidrawAPI: () => api as never }),
    )
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeSnapshotWithImage('shared-file'))
    // Let applyLoroToExcalidraw start and call backend.getFile — it awaits
    // the still-pending `deferred.promise`.
    await Promise.resolve()

    // Torn down (e.g. backend switched to null) before the fetch resolves,
    // with no successor session ever created.
    session.dispose()

    deferred.resolve(new Blob(['stale'], { type: 'text/plain' }))
    // blobToBase64 goes through a real FileReader, which completes on a
    // macrotask rather than a plain microtask — advancing fake timers (not
    // just chained microtasks) is required to let it settle.
    await vi.runAllTimersAsync()

    expect(api.addFiles).not.toHaveBeenCalled()
    expect(api.updateScene).not.toHaveBeenCalled()
  })

  it('dispose() invokes backend.pushLocalUpdate for the flush-triggered commit before calling backend.disconnect()', async () => {
    // Regression for the drain phase: disconnect() must never be called
    // before the flush-triggered commit's subscribeLocalUpdates callback has
    // invoked pushLocalUpdate, or the last edit made just before teardown
    // never reaches the transport. Tracking call ORDER (not settle order) is
    // the right assertion — a real transport's pushLocalUpdate may take an
    // arbitrarily long time to settle (network ack), but the *call* itself
    // is what puts bytes on a still-open connection.
    const callOrder: string[] = []
    const backend: CanvasBackend & { _ctrl: FakeBackendControl } = {
      ...makeFakeBackend(),
      pushLocalUpdate(_bytes) {
        callOrder.push('push-called')
        return new Promise(() => {}) // never settles — disconnect must not wait for this
      },
      disconnect() {
        callOrder.push('disconnect')
      },
    }
    const session = createCanvasSyncSession(backend, makeDeps())
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeEmptySnapshot())

    session.onChange([{ id: 'el-1', type: 'rectangle' } as never], {})
    session.dispose()

    // Drain microtask turns without advancing fake timers (real transport
    // call scheduling is not timer-driven).
    await flushMicrotasks()

    expect(callOrder).toEqual(['push-called', 'disconnect'])
  })

  it('dispose() falls through to disconnect via the drain timeout when the commit chain is stuck behind a hung putFile', async () => {
    // Regression for DISPOSE_DRAIN_TIMEOUT_MS itself: a putFile that never
    // settles blocks the commit chain for up to PUT_FILE_TIMEOUT_MS (15s),
    // far longer than the 2s drain bound. dispose() must still disconnect
    // once the drain timeout elapses, without waiting for the stuck chain.
    const backend: CanvasBackend & { _ctrl: FakeBackendControl } = {
      ...makeFakeBackend(),
      putFile: () => new Promise(() => {}), // never resolves — simulates a hung upload
    }
    const session = createCanvasSyncSession(backend, makeDeps())
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeEmptySnapshot())

    session.onChange([{ id: 'el-1', type: 'rectangle' } as never], {
      'file-1': { id: 'file-1', dataURL: 'data:,' } as never,
    })
    session.dispose()

    // Only the drain timeout (2s) elapses here, well short of the putFile
    // race's own 15s deadline, so the chain is still stuck on putFile.
    await vi.advanceTimersByTimeAsync(2_000)

    expect(backend._ctrl.pushLocalUpdateCalls).toHaveLength(0)
    expect(backend._ctrl.disconnectCalled).toBe(true)
  })

  it('dispose() disconnects synchronously when nothing is pending (fast path, no drain)', () => {
    // Regression for the pendingCommitCount === 0 branch: with no onChange
    // ever fired, dispose() must call backend.disconnect() synchronously —
    // not behind any await — preserving the "callers do not await dispose()"
    // contract for the common no-edit teardown path.
    const backend = makeFakeBackend()
    const session = createCanvasSyncSession(backend, makeDeps())
    session.connect()

    session.dispose()

    expect(backend._ctrl.disconnectCalled).toBe(true)
  })

  it('onAuthError sets error status and invokes options.onAuthError via getOptions', () => {
    const backend = makeFakeBackend()
    const onStatusChange = vi.fn()
    const onAuthError = vi.fn()
    const session = createCanvasSyncSession(
      backend,
      makeDeps({ onStatusChange, getOptions: () => ({ onAuthError }) }),
    )
    session.connect()

    backend._ctrl.handlers!.onAuthError?.()

    expect(onStatusChange).toHaveBeenCalledWith('error')
    expect(onAuthError).toHaveBeenCalledTimes(1)
  })
})
