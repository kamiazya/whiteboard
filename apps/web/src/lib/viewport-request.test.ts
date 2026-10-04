// @vitest-environment node
import type { ViewportRequestPayload } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { MAX_VIEWPORT_ZOOM, MIN_VIEWPORT_ZOOM } from '@kamiazya/whiteboard-model'
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
    const handle: SpatialEditorHandle = {
      setViewport: vi.fn(),
      fitToContent: vi.fn(),
      openProposal: vi.fn(),
    }
    applyViewportRequest(payload({ mode: 'fit', elementIds: ['a', 'b'] }), handle)
    expect(handle.fitToContent).toHaveBeenCalledWith(['a', 'b'])
    expect(handle.setViewport).not.toHaveBeenCalled()
  })

  it('routes mode: move to setViewport', () => {
    const handle: SpatialEditorHandle = {
      setViewport: vi.fn(),
      fitToContent: vi.fn(),
      openProposal: vi.fn(),
    }
    applyViewportRequest(payload({ mode: 'move', scrollX: 10, scrollY: 20, zoom: 2 }), handle)
    expect(handle.setViewport).toHaveBeenCalledWith({ x: 10, y: 20, zoom: 2 })
    expect(handle.fitToContent).not.toHaveBeenCalled()
  })

  it('is a total no-op when no editor is mounted (handle is null)', () => {
    expect(() => applyViewportRequest(payload({ mode: 'fit' }), null)).not.toThrow()
  })

  it('defaults an absent mode to fit, matching the daemon route contract', () => {
    const handle: SpatialEditorHandle = {
      setViewport: vi.fn(),
      fitToContent: vi.fn(),
      openProposal: vi.fn(),
    }
    applyViewportRequest(payload({ elementIds: ['a'] }), handle)
    expect(handle.fitToContent).toHaveBeenCalledWith(['a'])
    expect(handle.setViewport).not.toHaveBeenCalled()
  })

  it('defaults an absent mode to move when scroll or zoom arrive without elementIds', () => {
    // A caller that names a position and a zoom means to go there; reading
    // that as "fit the whole board" would drop the call on the floor.
    const handle: SpatialEditorHandle = {
      setViewport: vi.fn(),
      fitToContent: vi.fn(),
      openProposal: vi.fn(),
    }
    applyViewportRequest(payload({ scrollX: 400, scrollY: 300, zoom: 0.5 }), handle)
    expect(handle.setViewport).toHaveBeenCalledWith({ x: 400, y: 300, zoom: 0.5 })
    expect(handle.fitToContent).not.toHaveBeenCalled()
  })

  it('defaults an absent mode to move for a lone zoom', () => {
    const handle: SpatialEditorHandle = {
      setViewport: vi.fn(),
      fitToContent: vi.fn(),
      openProposal: vi.fn(),
    }
    applyViewportRequest(payload({ zoom: 2 }), handle)
    expect(handle.setViewport).toHaveBeenCalledWith({ x: 0, y: 0, zoom: 2 })
  })

  it('keeps an absent mode as fit when elementIds are named, even beside a zoom', () => {
    const handle: SpatialEditorHandle = {
      setViewport: vi.fn(),
      fitToContent: vi.fn(),
      openProposal: vi.fn(),
    }
    applyViewportRequest(payload({ elementIds: ['a'], zoom: 2 }), handle)
    expect(handle.fitToContent).toHaveBeenCalledWith(['a'])
    expect(handle.setViewport).not.toHaveBeenCalled()
  })

  it('keeps an absent mode as fit when nothing else is given', () => {
    const handle: SpatialEditorHandle = {
      setViewport: vi.fn(),
      fitToContent: vi.fn(),
      openProposal: vi.fn(),
    }
    applyViewportRequest(payload(), handle)
    expect(handle.fitToContent).toHaveBeenCalledWith(undefined)
    expect(handle.setViewport).not.toHaveBeenCalled()
  })

  it('degrades missing scroll/zoom fields to the identity viewport rather than throwing', () => {
    const handle: SpatialEditorHandle = {
      setViewport: vi.fn(),
      fitToContent: vi.fn(),
      openProposal: vi.fn(),
    }
    applyViewportRequest(payload({ mode: 'move' }), handle)
    expect(handle.setViewport).toHaveBeenCalledWith({ x: 0, y: 0, zoom: 1 })
  })

  // What the browser does with the combinations `wb_viewport_set` refuses, and
  // with the defaults its parameter descriptions state: a frame from a daemon
  // that did not refuse them still lands somewhere defined.
  type Overrides = Partial<Omit<ViewportRequestPayload, 'type' | 'requestId'>>
  const mountedHandle = (): SpatialEditorHandle => ({
    setViewport: vi.fn(),
    fitToContent: vi.fn(),
    openProposal: vi.fn(),
  })

  it.each<[Overrides, string[] | undefined]>([
    [{ mode: 'fit', zoom: 2 }, undefined],
    [{ mode: 'fit', scrollX: 9, scrollY: 9 }, undefined],
    [{ mode: 'fit', elementIds: ['a'], zoom: 2 }, ['a']],
  ])('applies mode fit as a fit and ignores the position it was also given (%j)', (overrides, framed) => {
    const handle = mountedHandle()
    applyViewportRequest(payload(overrides), handle)
    expect(handle.fitToContent).toHaveBeenCalledWith(framed)
    expect(handle.setViewport).not.toHaveBeenCalled()
  })

  it.each<[Overrides, { x: number; y: number; zoom: number }]>([
    [
      { mode: 'move', elementIds: ['a'] },
      { x: 0, y: 0, zoom: 1 },
    ],
    [
      { mode: 'move', elementIds: [], scrollX: 3 },
      { x: 3, y: 0, zoom: 1 },
    ],
    [
      { mode: 'move', scrollY: 4 },
      { x: 0, y: 4, zoom: 1 },
    ],
    [
      { mode: 'move', zoom: 2 },
      { x: 0, y: 0, zoom: 2 },
    ],
  ])('applies mode move as a move, ignoring elementIds and defaulting what is omitted to 0, 0 and 1 (%j)', (overrides, expected) => {
    const handle = mountedHandle()
    applyViewportRequest(payload(overrides), handle)
    expect(handle.setViewport).toHaveBeenCalledWith(expected)
    expect(handle.fitToContent).not.toHaveBeenCalled()
  })

  it.each([
    [0, MIN_VIEWPORT_ZOOM],
    [-3, MIN_VIEWPORT_ZOOM],
    [1e9, MAX_VIEWPORT_ZOOM],
    [100, MAX_VIEWPORT_ZOOM],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
  ])('clamps a zoom of %s to the editor range so the pan/zoom never goes non-finite', (zoom, expected) => {
    // An older daemon forwards the value unbounded; the screen/canvas
    // transform divides by zoom, so 0 would turn every coordinate into NaN.
    const handle: SpatialEditorHandle = {
      setViewport: vi.fn(),
      fitToContent: vi.fn(),
      openProposal: vi.fn(),
    }
    applyViewportRequest(payload({ mode: 'move', scrollX: 5, scrollY: 6, zoom }), handle)
    expect(handle.setViewport).toHaveBeenCalledWith({ x: 5, y: 6, zoom: expected })
  })
})
