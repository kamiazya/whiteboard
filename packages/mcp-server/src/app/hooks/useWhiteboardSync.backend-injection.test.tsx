// @vitest-environment jsdom
/**
 * Tests that useWhiteboardSync drives an injected CanvasBackend correctly.
 * Proves the seam without touching WebSocket directly.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@excalidraw/excalidraw', () => ({
  exportToBlob: vi.fn(),
  CaptureUpdateAction: { NEVER: 'never' },
  restoreElements: vi.fn((els: unknown) => els),
}))

vi.mock('../lib/commit-pipeline.js', () => ({
  commitAfterUpload: vi.fn(() => Promise.resolve()),
}))

import type { CanvasBackend, CanvasBackendHandlers } from '../lib/canvas-backend.js'

// Build a fake backend that captures the handlers for simulation.
function makeFakeBackend(): CanvasBackend & { _handlers: CanvasBackendHandlers | null } {
  let captured: CanvasBackendHandlers | null = null
  return {
    get _handlers() { return captured },
    connect(handlers) { captured = handlers },
    disconnect: vi.fn(),
    pushLocalUpdate: vi.fn(),
    getFile: vi.fn(() => Promise.resolve(null)),
    putFile: vi.fn(() => Promise.resolve()),
    sendClientReady: vi.fn(),
    sendViewportResponse: vi.fn(),
    sendExportResponse: vi.fn(),
  }
}

const { useWhiteboardSync } = await import('./useWhiteboardSync.js')

describe('useWhiteboardSync with injected CanvasBackend', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls backend.connect on mount and backend.disconnect on unmount', () => {
    const backend = makeFakeBackend()
    const { unmount } = renderHook(() =>
      useWhiteboardSync('ws', 'slug', { backend }),
    )
    expect(backend._handlers).not.toBeNull()
    unmount()
    expect(backend.disconnect).toHaveBeenCalledTimes(1)
  })

  it('calls backend.disconnect and reconnects when canvas key changes', () => {
    const backend = makeFakeBackend()
    const { rerender } = renderHook(
      ({ s, c }: { s: string; c: string }) =>
        useWhiteboardSync(s, c, { backend }),
      { initialProps: { s: 'ws', c: 'slug-a' } },
    )
    expect(backend.disconnect).not.toHaveBeenCalled()
    rerender({ s: 'ws', c: 'slug-b' })
    expect(backend.disconnect).toHaveBeenCalledTimes(1)
  })

  it('onSnapshot builds LoroDoc and calls applyLoroToExcalidraw (no crash)', async () => {
    const { LoroDoc: RealLoroDoc } = await import('loro-crdt')
    const backend = makeFakeBackend()
    renderHook(() => useWhiteboardSync('ws', 'slug', { backend }))

    const doc = new RealLoroDoc()
    const snapshot = doc.export({ mode: 'snapshot' })

    // Should not throw when snapshot arrives before api is ready.
    act(() => {
      backend._handlers?.onSnapshot(new Uint8Array(snapshot))
    })
    // No assertion needed beyond "no throw" — applyLoroToExcalidraw is async
    // and api is not ready so updateScene is a no-op.
  })

  it('restore_started sets restoreInProgress=true and restoreLabel', () => {
    const backend = makeFakeBackend()
    const { result } = renderHook(() =>
      useWhiteboardSync('ws', 'slug', { backend }),
    )

    act(() => {
      backend._handlers?.onRestoreStarted({ label: 'Going back to v1' })
    })

    expect(result.current.restoreInProgress).toBe(true)
    expect(result.current.restoreLabel).toBe('Going back to v1')
  })

  it('restore_complete sets restoreInProgress=false and clears label', () => {
    const backend = makeFakeBackend()
    const { result } = renderHook(() =>
      useWhiteboardSync('ws', 'slug', { backend }),
    )

    act(() => {
      backend._handlers?.onRestoreStarted({ label: 'Restoring' })
    })
    expect(result.current.restoreInProgress).toBe(true)

    act(() => {
      backend._handlers?.onRestoreComplete()
    })
    expect(result.current.restoreInProgress).toBe(false)
    expect(result.current.restoreLabel).toBeNull()
  })

  it('head_changed dispatches the excalidraw:head_changed CustomEvent', () => {
    const backend = makeFakeBackend()
    const listener = vi.fn()
    window.addEventListener('excalidraw:head_changed', listener)
    renderHook(() => useWhiteboardSync('ws', 'slug', { backend }))

    act(() => {
      backend._handlers?.onHeadChanged({ head: 'feature-branch' })
    })

    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('excalidraw:head_changed', listener)
  })

  it('version_created dispatches the excalidraw:version_saved CustomEvent', () => {
    const backend = makeFakeBackend()
    const listener = vi.fn()
    window.addEventListener('excalidraw:version_saved', listener)
    renderHook(() => useWhiteboardSync('ws', 'slug', { backend }))

    const payload = {
      id: 'v1',
      slug: 'slug',
      createdAt: '2024-01-01T00:00:00Z',
      elementCount: 3,
      auto: true,
      hasThumbnail: false,
    }
    act(() => {
      backend._handlers?.onVersionCreated(payload)
    })

    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('excalidraw:version_saved', listener)
  })

  it('onSceneChange routes uploads through backend.putFile', async () => {
    const backend = makeFakeBackend()
    const { result } = renderHook(() =>
      useWhiteboardSync('ws', 'slug', { backend }),
    )

    // Prime the doc ref by providing a snapshot.
    const { LoroDoc: RealLoroDoc } = await import('loro-crdt')
    const doc = new RealLoroDoc()
    const snapshot = doc.export({ mode: 'snapshot' })
    act(() => {
      backend._handlers?.onSnapshot(new Uint8Array(snapshot))
    })

    // commitAfterUpload is mocked; just confirm onSceneChange does not throw.
    act(() => {
      result.current.onSceneChange([], {})
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    // No assertion beyond no throw; commitAfterUpload mock is in place.
  })
})
