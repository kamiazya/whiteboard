/**
 * useDocumentSync unit tests — jsdom layer.
 *
 * No Excalidraw mocking: the hook's whole surface is now SpatialCanvas +
 * EditorCommand, driven by a fake DocumentBackend. Per-connection ordering/
 * drain semantics (commit chain, pendingCommitCount, fine-grained writes) are
 * exercised at the nearer document-sync-session.test.ts layer; this file
 * covers the hook's own React wiring: canvas state, subscribe/dispose,
 * keyboard undo/redo, identity events, and exportScene's editor-independent
 * derivation.
 */

import { writeCommentThread, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'

import type {
  DocumentBackend,
  DocumentBackendHandlers,
  VersionCreatedPayload,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { act, renderHook } from '@testing-library/react'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

// Only the embedding function is faked; the rest of canvas-viewer stays real.
const { embedSpy } = vi.hoisted(() => ({ embedSpy: vi.fn(async (svg: string) => svg) }))
vi.mock('@kamiazya/whiteboard-canvas-viewer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kamiazya/whiteboard-canvas-viewer')>()),
  withViewerFontEmbedded: embedSpy,
}))

import type { SpatialEditorProps } from '../components/spatial-editor/index.js'
import type { EditorCommand } from '../lib/spatial/commands.js'
import { applyCommand } from '../lib/spatial/commands.js'
import { type UseDocumentSyncResult, useDocumentSync } from './useDocumentSync.js'

type FakeBackendControl = {
  handlers: DocumentBackendHandlers | null
  disconnectCalled: boolean
  pushLocalUpdateCalls: Uint8Array[]
}

function makeFakeBackend(): DocumentBackend & { _ctrl: FakeBackendControl } {
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

function emptyCanvas(): SpatialCanvas {
  return { nodes: [], edges: [] }
}

function makeSnapshot(canvas: SpatialCanvas = emptyCanvas()): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvas)
  return doc.export({ mode: 'snapshot' })
}

/** A snapshot carrying one open thread on the annotation plane. */
function makeSnapshotWithThread(canvas: SpatialCanvas = emptyCanvas()): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvas)
  writeCommentThread(doc, {
    id: 't-a',
    anchor: { kind: 'spatial', x: 5, y: 5 },
    status: 'open',
    messages: [{ id: 'm-a', body: 'belongs to the first document' }],
  })
  return doc.export({ mode: 'snapshot' })
}

const TEXT_NODE: SpatialCanvas['nodes'][number] = {
  id: 'n-a',
  type: 'text',
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  text: 'hello',
}

const TEXT_CANVAS: SpatialCanvas = { nodes: [TEXT_NODE], edges: [] }

const MOVE_TEXT_NODE: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }

function versionCreatedPayload(
  overrides: Partial<VersionCreatedPayload> = {},
): VersionCreatedPayload {
  return {
    id: 'v1',
    path: 'canvas-a',
    createdAt: '2026-01-01T00:00:00.000Z',
    elementCount: 3,
    auto: false,
    hasThumbnail: false,
    branchName: 'main',
    ...overrides,
  }
}

/** Delivers a snapshot through the backend and drains the import pipeline. */
async function hydrate(
  backend: ReturnType<typeof makeFakeBackend>,
  canvas: SpatialCanvas = emptyCanvas(),
): Promise<void> {
  await act(async () => {
    backend._ctrl.handlers!.onSnapshot(makeSnapshot(canvas))
    await vi.runAllTimersAsync()
  })
}

/** Applies a command through the hook's onChange and drains the commit debounce. */
async function edit(
  result: { current: UseDocumentSyncResult },
  before: SpatialCanvas,
  command: EditorCommand,
): Promise<void> {
  const next = applyCommand(before, command)
  act(() => {
    result.current.onChange(next, command)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400)
  })
}

function dispatchCtrlZ(): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }),
  )
}

describe('useDocumentSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('seeds canvas to the empty canvas and updates it once a snapshot arrives', async () => {
    const backend = makeFakeBackend()
    const { result } = renderHook(() => useDocumentSync(backend))

    expect(result.current.canvas).toEqual(emptyCanvas())

    await hydrate(backend, TEXT_CANVAS)

    expect(result.current.canvas).toEqual(TEXT_CANVAS)
  })

  it('sets syncStatus to "connected" when onConnected fires', () => {
    const backend = makeFakeBackend()
    const { result } = renderHook(() => useDocumentSync(backend))
    expect(result.current.syncStatus).toBe('connected')
  })

  it('reports WHY the backend failed, not only that it did', () => {
    const backend = makeFakeBackend()
    const { result } = renderHook(() => useDocumentSync(backend))

    act(() => {
      backend._ctrl.handlers!.onError?.('unsupported-version')
    })

    expect(result.current.backendError).toBe('unsupported-version')
  })

  it('drops the reason when the backend changes, so it cannot outlive its document', () => {
    // The reason describes ONE document. Carried across a switch it turns the
    // next document — which may be perfectly readable — into an error screen,
    // and the page has no way to tell the difference.
    const broken = makeFakeBackend()
    const { result, rerender } = renderHook(({ backend }) => useDocumentSync(backend), {
      initialProps: { backend: broken },
    })
    act(() => {
      broken._ctrl.handlers!.onError?.('unsupported-version')
    })
    expect(result.current.backendError).toBe('unsupported-version')

    rerender({ backend: makeFakeBackend() })

    expect(result.current.backendError).toBeNull()
  })

  // The page judges "is my work safe" from facts the session reports, not
  // from the debounce: an edit is unsaved from the instant it is published,
  // and saved only once the write behind it has landed in the store.
  it('exposes the session persistence facts, pending on publish and saved on landing', async () => {
    const backend = makeFakeBackend()
    const { result } = renderHook(() => useDocumentSync(backend))
    await hydrate(backend)
    expect(result.current.persistence).toEqual({ kind: 'saved', lastSavedAt: null })

    const move: EditorCommand = { kind: 'move-node', id: 'n1', x: 5, y: 5 }
    act(() => {
      result.current.onChange(applyCommand(emptyCanvas(), move), move)
    })
    expect(result.current.persistence.kind).toBe('pending')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(result.current.persistence.kind).toBe('saved')
    expect(result.current.persistence.lastSavedAt).not.toBeNull()
  })

  it('sets syncStatus to "error" when onError fires', () => {
    const backend = makeFakeBackend()
    const { result } = renderHook(() => useDocumentSync(backend))

    act(() => {
      backend._ctrl.handlers!.onError?.('storage-failure')
    })

    expect(result.current.syncStatus).toBe('error')
  })

  it('forwards onChange(next, command) straight through to the session', async () => {
    const backend = makeFakeBackend()
    const { result } = renderHook(() => useDocumentSync(backend))

    await hydrate(backend, TEXT_CANVAS)

    const next = applyCommand(TEXT_CANVAS, MOVE_TEXT_NODE)
    act(() => {
      result.current.onChange(next, MOVE_TEXT_NODE)
    })

    // The hook publishes the session's forwarded value synchronously.
    expect(result.current.canvas).toEqual(next)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    expect(backend._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(0)
  })

  it('calls backend.disconnect on unmount', () => {
    const backend = makeFakeBackend()
    const { unmount } = renderHook(() => useDocumentSync(backend))
    unmount()
    expect(backend._ctrl.disconnectCalled).toBe(true)
  })

  it('disposes the old session and subscribes to the new one on a backend swap', async () => {
    const backendA = makeFakeBackend()
    const backendB = makeFakeBackend()
    const { result, rerender } = renderHook(({ backend }) => useDocumentSync(backend), {
      initialProps: { backend: backendA as DocumentBackend },
    })

    await hydrate(backendA, TEXT_CANVAS)
    expect(result.current.canvas).toEqual(TEXT_CANVAS)

    rerender({ backend: backendB })

    expect(backendA._ctrl.disconnectCalled).toBe(true)
    // Torn down and reset — the new session has not hydrated yet.
    expect(result.current.canvas).toEqual(emptyCanvas())

    const otherCanvas: SpatialCanvas = {
      nodes: [{ ...TEXT_NODE, id: 'n-b', text: 'world' }],
      edges: [],
    }
    await hydrate(backendB, otherCanvas)
    expect(result.current.canvas).toEqual(otherCanvas)
  })

  it('clears the locked set when the backend goes away', async () => {
    const backend = makeFakeBackend()
    const { result, rerender } = renderHook(({ backend }) => useDocumentSync(backend), {
      initialProps: { backend: backend as DocumentBackend | null },
    })

    await hydrate(backend, TEXT_CANVAS)
    act(() => {
      result.current.setNodeLock(TEXT_NODE.id, true)
    })
    expect([...result.current.lockedNodeIds]).toEqual([TEXT_NODE.id])

    // Disconnecting leaves no session to own this state; reporting the
    // disposed canvas's locks would lock nodes of whatever comes next.
    rerender({ backend: null })
    expect([...result.current.lockedNodeIds]).toEqual([])
  })

  it('clears the annotation layer when the backend goes away', async () => {
    const backend = makeFakeBackend()
    const { result, rerender } = renderHook(({ backend }) => useDocumentSync(backend), {
      initialProps: { backend: backend as DocumentBackend | null },
    })

    await act(async () => {
      backend._ctrl.handlers!.onSnapshot(makeSnapshotWithThread(TEXT_CANVAS))
      await vi.runAllTimersAsync()
    })
    expect(result.current.annotations.map((thread) => thread.id)).toEqual(['t-a'])

    // Conversations belong to the document being torn down, exactly as the
    // locks and the body do. Left standing they would be listed in the rail
    // against whatever document comes next — and with no successor session to
    // publish over them, they would stay there indefinitely.
    rerender({ backend: null })
    expect(result.current.annotations).toEqual([])
  })

  it('does not connect when backend is null, and onChange is a safe no-op', () => {
    const { result } = renderHook(({ backend }) => useDocumentSync(backend), {
      initialProps: { backend: null as DocumentBackend | null },
    })

    expect(result.current.syncStatus).toBe('idle')
    expect(result.current.canvas).toEqual(emptyCanvas())
    const command: EditorCommand = { kind: 'move-node', id: 'x', x: 0, y: 0 }
    expect(() => result.current.onChange(emptyCanvas(), command)).not.toThrow()
  })

  it('undo/redo keyboard shortcuts are safe no-ops when backend is null', () => {
    const { result } = renderHook(({ backend }) => useDocumentSync(backend), {
      initialProps: { backend: null as DocumentBackend | null },
    })

    expect(dispatchCtrlZ).not.toThrow()
    expect(result.current.canvas).toEqual(emptyCanvas())
  })

  it('undo republishes the canvas after a keyboard undo', async () => {
    const backend = makeFakeBackend()
    const { result } = renderHook(() => useDocumentSync(backend))

    await hydrate(backend, TEXT_CANVAS)
    await edit(result, TEXT_CANVAS, MOVE_TEXT_NODE)
    expect(result.current.canvas.nodes[0]).toMatchObject({ x: 10, y: 20 })

    act(dispatchCtrlZ)

    expect(result.current.canvas.nodes[0]).toMatchObject({ x: 0, y: 0 })
  })

  it('connects when backend changes from null to a real backend', () => {
    const backend = makeFakeBackend()
    const { result, rerender } = renderHook(({ backend }) => useDocumentSync(backend), {
      initialProps: { backend: null as DocumentBackend | null },
    })

    expect(result.current.syncStatus).toBe('idle')

    rerender({ backend })

    expect(backend._ctrl.handlers).not.toBeNull()
    expect(result.current.syncStatus).toBe('connected')
  })

  it('sets syncStatus to "error" and does not resurrect A when switching to a backend whose connect fails', () => {
    const backendA = makeFakeBackend()
    const { result, rerender } = renderHook(({ backend }) => useDocumentSync(backend), {
      initialProps: { backend: backendA as DocumentBackend },
    })

    expect(result.current.syncStatus).toBe('connected')

    const failingBackend: DocumentBackend & { _ctrl: FakeBackendControl } = {
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
      renderHook(() => useDocumentSync(backend, { onVersionCreated }))

      const payload = versionCreatedPayload()
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
        ({ backend }) => useDocumentSync(backend, { onVersionCreated }),
        {
          initialProps: { backend: backendA as DocumentBackend },
        },
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
      renderHook(() => useDocumentSync(backend, { onHeadChanged }))

      const payload = { head: 'branch-1' }
      act(() => {
        backend._ctrl.handlers!.onHeadChanged(payload as never)
      })

      expect(onHeadChanged).toHaveBeenCalledWith(payload)
    })

    it('sets restoreInProgress/restoreLabel on onRestoreStarted and clears them on onRestoreComplete', () => {
      const backend = makeFakeBackend()
      const { result } = renderHook(() => useDocumentSync(backend))

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

    it('resets restoreInProgress/restoreLabel when the restoring connection is superseded', () => {
      const backendA = makeFakeBackend()
      const backendB = makeFakeBackend()
      const { result, rerender } = renderHook(({ backend }) => useDocumentSync(backend), {
        initialProps: { backend: backendA as DocumentBackend },
      })

      act(() => {
        backendA._ctrl.handlers!.onRestoreStarted({ label: 'Restoring v3' } as never)
      })
      expect(result.current.restoreInProgress).toBe(true)

      act(() => {
        rerender({ backend: backendB })
      })

      expect(result.current.restoreInProgress).toBe(false)
      expect(result.current.restoreLabel).toBe(null)
    })

    it('clearLocalUndo() delegates to the session so undo becomes a no-op', async () => {
      const backend = makeFakeBackend()
      const { result } = renderHook(() => useDocumentSync(backend))

      await hydrate(backend, TEXT_CANVAS)
      await edit(result, TEXT_CANVAS, MOVE_TEXT_NODE)

      act(() => {
        result.current.clearLocalUndo()
      })

      const canvasBeforeUndo = result.current.canvas
      act(dispatchCtrlZ)
      expect(result.current.canvas).toBe(canvasBeforeUndo)
    })

    it('sets syncStatus to "error" when onAuthError fires', () => {
      const backend = makeFakeBackend()
      const { result } = renderHook(() => useDocumentSync(backend))

      act(() => {
        backend._ctrl.handlers!.onAuthError?.()
      })

      expect(result.current.syncStatus).toBe('error')
    })

    it('drops a stale-generation onAuthError from a torn-down connection', () => {
      const backendA = makeFakeBackend()
      const backendB = makeFakeBackend()
      const { result, rerender } = renderHook(({ backend }) => useDocumentSync(backend), {
        initialProps: { backend: backendA as DocumentBackend },
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
      const { result } = renderHook(() => useDocumentSync(backend, { onAuthError }))

      act(() => {
        backend._ctrl.handlers!.onAuthError?.()
      })

      expect(onAuthError).toHaveBeenCalledTimes(1)
      expect(result.current.syncStatus).toBe('error')
    })

    it('calls sendClientReady on connect and again once onEditorReady fires', () => {
      const backend = makeFakeBackend()
      const sendClientReadySpy = vi.spyOn(backend, 'sendClientReady')

      renderHook(() => useDocumentSync(backend))

      // Once on connect(), once on the hook's own onEditorReady() call —
      // there is no separate "editor mounted" event to gate on anymore, so
      // the hook calls it unconditionally right after connecting.
      expect(sendClientReadySpy).toHaveBeenCalledTimes(2)
    })
  })

  describe('onViewportRequest', () => {
    it('forwards the payload to the page-supplied onViewportRequest option', () => {
      const backend = makeFakeBackend()
      const onViewportRequest = vi.fn()
      renderHook(() => useDocumentSync(backend, { onViewportRequest }))

      const payload = { mode: 'fit' as const, requestId: 'req-1' }
      backend._ctrl.handlers!.onViewportRequest(payload)

      expect(onViewportRequest).toHaveBeenCalledWith(payload)
    })

    it('is a no-op (never throws) with no onViewportRequest option supplied', () => {
      const backend = makeFakeBackend()
      renderHook(() => useDocumentSync(backend))

      expect(() => {
        backend._ctrl.handlers!.onViewportRequest({ mode: 'fit' } as never)
      }).not.toThrow()
    })
  })

  describe('onExportRequest', () => {
    it('queues a request (never sent) since this session has no imperative editor handle to serve it', async () => {
      const backend = makeFakeBackend()
      const sendExportResponseSpy = vi.spyOn(backend, 'sendExportResponse')
      renderHook(() => useDocumentSync(backend))

      await act(async () => {
        await backend._ctrl.handlers!.onExportRequest({ requestId: 'req-1' } as never)
      })

      // lane B (document-sync-export.ts) owns replacing the Excalidraw-shaped
      // ExportRequestHandlerDeps this queues against — until then, every
      // export request queues and is never actually served.
      expect(sendExportResponseSpy).not.toHaveBeenCalled()
    })
  })

  describe('identity events', () => {
    const identity = { workspaceId: 'ws-1', path: 'canvas-a' }

    function listenFor(eventName: string): { calls: CustomEvent[] } {
      const state = { calls: [] as CustomEvent[] }
      window.addEventListener(eventName, ((e: Event) => {
        state.calls.push(e as CustomEvent)
      }) as EventListener)
      return state
    }

    it('does not dispatch doc_changed for the initial snapshot import', async () => {
      const backend = makeFakeBackend()
      const docChanged = listenFor('whiteboard:doc_changed')
      renderHook(() => useDocumentSync(backend, { identity }))

      await hydrate(backend)

      expect(docChanged.calls).toHaveLength(0)
    })

    it('dispatches doc_changed on a local scene edit commit', async () => {
      const backend = makeFakeBackend()
      const docChanged = listenFor('whiteboard:doc_changed')
      const { result } = renderHook(() => useDocumentSync(backend, { identity }))

      await hydrate(backend, TEXT_CANVAS)
      await edit(result, TEXT_CANVAS, MOVE_TEXT_NODE)

      expect(docChanged.calls.length).toBeGreaterThan(0)
      expect(docChanged.calls[docChanged.calls.length - 1].detail).toEqual(identity)
    })

    it('dispatches wb_version_saved with identity detail when a version_created broadcast arrives', () => {
      const backend = makeFakeBackend()
      const versionSaved = listenFor('whiteboard:wb_version_saved')
      renderHook(() => useDocumentSync(backend, { identity }))

      act(() => {
        backend._ctrl.handlers!.onVersionCreated(versionCreatedPayload())
      })

      expect(versionSaved.calls).toHaveLength(1)
      expect(versionSaved.calls[0].detail).toEqual(identity)
    })

    it('does not dispatch any identity events when identity is absent', async () => {
      const backend = makeFakeBackend()
      const docChanged = listenFor('whiteboard:doc_changed')
      const versionSaved = listenFor('whiteboard:wb_version_saved')
      renderHook(() => useDocumentSync(backend))

      await hydrate(backend)
      await act(async () => {
        backend._ctrl.handlers!.onRemoteUpdate(new LoroDoc().export({ mode: 'update' }))
        await vi.runAllTimersAsync()
      })
      act(() => {
        backend._ctrl.handlers!.onVersionCreated(versionCreatedPayload({ elementCount: 0 }))
      })

      expect(docChanged.calls).toHaveLength(0)
      expect(versionSaved.calls).toHaveLength(0)
    })

    it('changing the identity option between renders does not force a backend reconnect', () => {
      const backend = makeFakeBackend()
      const connectSpy = vi.spyOn(backend, 'connect')
      const { rerender } = renderHook(({ id }) => useDocumentSync(backend, { identity: id }), {
        initialProps: { id: identity },
      })

      rerender({ id: { workspaceId: 'ws-1', path: 'canvas-b' } })
      rerender({ id: { workspaceId: 'ws-2', path: 'canvas-c' } })

      expect(connectSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('exportScene', () => {
    it("returns a non-empty 'svg' blob derived from the hook's own canvas value, with no editor ref ever supplied", async () => {
      const backend = makeFakeBackend()
      const { result } = renderHook(() => useDocumentSync(backend))

      await hydrate(backend, TEXT_CANVAS)

      let blob: Blob | null | undefined
      await act(async () => {
        blob = await result.current.exportScene('svg')
      })

      expect(blob).not.toBeNull()
      expect(blob?.type).toBe('image/svg+xml')
      expect(blob?.size).toBeGreaterThan(0)
    })

    // The wiring half. That an embedded face actually changes a rasterised
    // SVG is proved in canvas-viewer's own browser test, under a family name
    // no system font can match; asserting it on pixels HERE would be vacuous
    // on any machine that happens to have Roboto installed.
    it('embeds the viewer face for png, and leaves a saved svg alone', async () => {
      const backend = makeFakeBackend()
      const { result } = renderHook(() => useDocumentSync(backend))
      await hydrate(backend, TEXT_CANVAS)
      embedSpy.mockClear()

      await act(async () => {
        await result.current.exportScene('svg')
      })
      // A saved .svg names the family without carrying it: embedding would add
      // ~466 KB for a face any viewer with Roboto already has.
      expect(embedSpy).not.toHaveBeenCalled()

      await act(async () => {
        await result.current.exportScene('png')
      })
      expect(embedSpy).toHaveBeenCalledTimes(1)
      // What it embeds into is the rendered scene, not some other string.
      expect(embedSpy.mock.calls[0]?.[0]).toContain('<svg')
    })

    it('derives the svg from the empty canvas (still non-null) before any snapshot has arrived', async () => {
      const backend = makeFakeBackend()
      const { result } = renderHook(() => useDocumentSync(backend))

      const blob = await result.current.exportScene('svg')

      expect(blob).not.toBeNull()
      expect(blob?.type).toBe('image/svg+xml')
    })
  })

  describe('type-level: no Excalidraw surface remains', () => {
    it('UseDocumentSyncResult has no setExcalidrawAPI, and its onChange is assignable to SpatialEditorProps["onChange"]', () => {
      expectTypeOf<UseDocumentSyncResult>().not.toHaveProperty('setExcalidrawAPI')
      expectTypeOf<UseDocumentSyncResult['onChange']>().toEqualTypeOf<
        SpatialEditorProps['onChange']
      >()
      expectTypeOf<UseDocumentSyncResult['canvas']>().not.toBeAny()
    })
  })
})
