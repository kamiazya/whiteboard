// @vitest-environment node
import type { ViewportRequestPayload } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { describe, expect, it, vi } from 'vitest'
import type { SpatialEditorHandle } from './spatial/editor-handle.js'
import { applyViewportRequest } from './viewport-request.js'

function payload(
  overrides: Partial<Omit<ViewportRequestPayload, 'type' | 'requestId'>> = {},
): Omit<ViewportRequestPayload, 'type'> {
  return { requestId: 'req-1', ...overrides }
}

describe('applyViewportRequest', () => {
  it('routes mode: fit to fitToContent, scoped to the given elementIds', () => {
    const handle: SpatialEditorHandle = { setViewport: vi.fn(), fitToContent: vi.fn() }
    applyViewportRequest(payload({ mode: 'fit', elementIds: ['a', 'b'] }), handle)
    expect(handle.fitToContent).toHaveBeenCalledWith(['a', 'b'])
    expect(handle.setViewport).not.toHaveBeenCalled()
  })

  it('routes mode: move to setViewport', () => {
    const handle: SpatialEditorHandle = { setViewport: vi.fn(), fitToContent: vi.fn() }
    applyViewportRequest(payload({ mode: 'move', scrollX: 10, scrollY: 20, zoom: 2 }), handle)
    expect(handle.setViewport).toHaveBeenCalledWith({ x: 10, y: 20, zoom: 2 })
    expect(handle.fitToContent).not.toHaveBeenCalled()
  })

  it('is a total no-op when no editor is mounted (handle is null)', () => {
    expect(() => applyViewportRequest(payload({ mode: 'fit' }), null)).not.toThrow()
  })

  it('defaults an absent mode to fit, matching the daemon route contract', () => {
    const handle: SpatialEditorHandle = { setViewport: vi.fn(), fitToContent: vi.fn() }
    applyViewportRequest(payload({ elementIds: ['a'] }), handle)
    expect(handle.fitToContent).toHaveBeenCalledWith(['a'])
    expect(handle.setViewport).not.toHaveBeenCalled()
  })

  it('degrades missing scroll/zoom fields to the identity viewport rather than throwing', () => {
    const handle: SpatialEditorHandle = { setViewport: vi.fn(), fitToContent: vi.fn() }
    applyViewportRequest(payload({ mode: 'move' }), handle)
    expect(handle.setViewport).toHaveBeenCalledWith({ x: 0, y: 0, zoom: 1 })
  })
})
