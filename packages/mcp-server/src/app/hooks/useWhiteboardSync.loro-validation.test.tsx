// @vitest-environment jsdom
/**
 * Tests that useWhiteboardSync drops corrupt Loro elements during hydration
 * and that valid siblings survive. Covers both the MovableList path and the
 * legacy List fallback path.
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

function makeFakeBackend(): CanvasBackend & { _handlers: CanvasBackendHandlers | null } {
  let captured: CanvasBackendHandlers | null = null
  return {
    get _handlers() {
      return captured
    },
    connect(handlers) {
      captured = handlers
    },
    disconnect: vi.fn(),
    pushLocalUpdate: vi.fn(),
    getFile: vi.fn(() => Promise.resolve(null)),
    putFile: vi.fn(() => Promise.resolve()),
    sendClientReady: vi.fn(),
    sendExportResponse: vi.fn(),
  }
}

const { useWhiteboardSync } = await import('./useWhiteboardSync.js')

describe('useWhiteboardSync Loro element validation', () => {
  let fakeApi: {
    addFiles: ReturnType<typeof vi.fn>
    updateScene: ReturnType<typeof vi.fn>
    getSceneElements: ReturnType<typeof vi.fn>
    getAppState: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    vi.useFakeTimers()
    fakeApi = {
      addFiles: vi.fn(),
      updateScene: vi.fn(),
      getSceneElements: vi.fn(() => []),
      getAppState: vi.fn(() => ({})),
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('MovableList path: drops corrupt element and renders valid sibling (does not blank canvas)', async () => {
    const { LoroDoc, LoroMap } = await import('loro-crdt')
    const backend = makeFakeBackend()
    const { result } = renderHook(() => useWhiteboardSync('ws', 'slug', { backend }))

    // Provide the Excalidraw API so updateScene can be called.
    act(() => {
      result.current.onApiReady(fakeApi as never)
    })

    // Build a LoroDoc with one valid element + one corrupt element (missing id).
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const validMap = list.insertContainer(0, new LoroMap())
    validMap.set('id', 'rect-valid')
    validMap.set('type', 'rectangle')
    validMap.set('x', 10)
    validMap.set('y', 20)
    validMap.set('width', 100)
    validMap.set('height', 50)
    // Corrupt: missing id field
    const corruptMap = list.insertContainer(1, new LoroMap())
    corruptMap.set('x', 5)
    corruptMap.set('y', 5)
    corruptMap.set('width', 30)
    corruptMap.set('height', 30)
    doc.commit()

    const snapshot = doc.export({ mode: 'snapshot' })

    await act(async () => {
      backend._handlers?.onSnapshot(new Uint8Array(snapshot))
    })

    // updateScene must have been called — canvas is NOT blank.
    expect(fakeApi.updateScene).toHaveBeenCalled()

    // The scene passed to updateScene must contain only the valid element.
    const calls = fakeApi.updateScene.mock.calls
    const lastCall = calls[calls.length - 1][0] as { elements?: unknown[] }
    expect(lastCall.elements).toBeDefined()
    expect(lastCall.elements!.length).toBe(1)
    const renderedEl = lastCall.elements![0] as { id?: string }
    expect(renderedEl.id).toBe('rect-valid')
  })

  it('legacy List fallback path: drops corrupt element and renders valid sibling', async () => {
    const { LoroDoc, LoroMap } = await import('loro-crdt')
    const backend = makeFakeBackend()
    const { result } = renderHook(() => useWhiteboardSync('ws', 'slug', { backend }))

    act(() => {
      result.current.onApiReady(fakeApi as never)
    })

    // Build a LoroDoc that uses the legacy List (MovableList stays empty so the
    // fallback branch in applyLoroToExcalidraw is exercised).
    const doc = new LoroDoc()
    const legacyList = doc.getList('elements')
    const validMap = legacyList.insertContainer(0, new LoroMap())
    validMap.set('id', 'rect-legacy')
    validMap.set('type', 'rectangle')
    validMap.set('x', 50)
    validMap.set('y', 60)
    validMap.set('width', 80)
    validMap.set('height', 40)
    // Corrupt: missing id
    const corruptMap = legacyList.insertContainer(1, new LoroMap())
    corruptMap.set('x', 1)
    corruptMap.set('y', 2)
    corruptMap.set('width', 10)
    corruptMap.set('height', 10)
    doc.commit()

    const snapshot = doc.export({ mode: 'snapshot' })

    await act(async () => {
      backend._handlers?.onSnapshot(new Uint8Array(snapshot))
    })

    expect(fakeApi.updateScene).toHaveBeenCalled()

    const calls = fakeApi.updateScene.mock.calls
    const lastCall = calls[calls.length - 1][0] as { elements?: unknown[] }
    expect(lastCall.elements).toBeDefined()
    expect(lastCall.elements!.length).toBe(1)
    const renderedEl = lastCall.elements![0] as { id?: string }
    expect(renderedEl.id).toBe('rect-legacy')
  })

  it('onDropped callback is invoked once per corrupt element', async () => {
    const { LoroDoc, LoroMap } = await import('loro-crdt')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const backend = makeFakeBackend()
    renderHook(() => useWhiteboardSync('ws', 'slug', { backend }))

    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    // One valid element
    const validMap = list.insertContainer(0, new LoroMap())
    validMap.set('id', 'r1')
    validMap.set('x', 0)
    validMap.set('y', 0)
    validMap.set('width', 10)
    validMap.set('height', 10)
    // Two corrupt elements
    const c1 = list.insertContainer(1, new LoroMap())
    c1.set('x', 1)
    c1.set('y', 1)
    c1.set('width', 5)
    c1.set('height', 5)
    const c2 = list.insertContainer(2, new LoroMap())
    c2.set('x', 2)
    c2.set('y', 2)
    c2.set('width', 6)
    c2.set('height', 6)
    doc.commit()

    const snapshot = doc.export({ mode: 'snapshot' })

    await act(async () => {
      backend._handlers?.onSnapshot(new Uint8Array(snapshot))
    })

    // console.warn must have been called exactly twice (once per corrupt row).
    expect(warnSpy).toHaveBeenCalledTimes(2)
    warnSpy.mockRestore()
  })
})
