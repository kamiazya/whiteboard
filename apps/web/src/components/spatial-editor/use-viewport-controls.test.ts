import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { NodeBox } from '../../lib/spatial/geometry.js'
import { IDENTITY_VIEWPORT } from '../../lib/spatial/viewport.js'
import { useViewportControls } from './use-viewport-controls.js'

const SIZE = { width: 800, height: 600 }
const root = document.createElement('div')

const box = (id: string, x: number, y: number): NodeBox => ({
  id,
  box: { x, y, width: 200, height: 80 },
})

function mount(initial: readonly NodeBox[]) {
  return renderHook(
    ({ boxes }: { boxes: readonly NodeBox[] }) =>
      useViewportControls({
        rootRef: { current: root },
        boxes,
        selection: undefined,
        extraIds: new Set(),
        viewportCenterScreen: () => ({ x: 400, y: 300 }),
        containerSizeOf: () => SIZE,
      }),
    { initialProps: { boxes: initial } },
  )
}

describe('opening a document whose content is off-screen', () => {
  it('frames the content when no box intersects the container', () => {
    const { result } = mount([box('a', 3000, 3000)])
    expect(result.current.viewport).not.toEqual(IDENTITY_VIEWPORT)
    const { x, y, zoom } = result.current.viewport
    // The box centre lands inside the container.
    const sx = (3100 - x) * zoom
    const sy = (3040 - y) * zoom
    expect(sx).toBeGreaterThan(0)
    expect(sx).toBeLessThan(SIZE.width)
    expect(sy).toBeGreaterThan(0)
    expect(sy).toBeLessThan(SIZE.height)
  })

  it('leaves the viewport alone when some content is already in view', () => {
    const { result } = mount([box('a', 100, 100), box('b', 3000, 3000)])
    expect(result.current.viewport).toEqual(IDENTITY_VIEWPORT)
  })

  it('does not reframe when a box is later added off-screen', () => {
    const { result, rerender } = mount([box('a', 100, 100)])
    rerender({ boxes: [box('a', 100, 100), box('b', 3000, 3000)] })
    expect(result.current.viewport).toEqual(IDENTITY_VIEWPORT)
  })

  it('does not reframe after the user pans away from the content', () => {
    const { result, rerender } = mount([box('a', 100, 100)])
    act(() => result.current.setViewport({ x: 5000, y: 5000, zoom: 1 }))
    rerender({ boxes: [box('a', 100, 100), box('b', 120, 120)] })
    expect(result.current.viewport).toEqual({ x: 5000, y: 5000, zoom: 1 })
  })

  it('frames again when the document empties and new off-screen content arrives', () => {
    const { result, rerender } = mount([box('a', 100, 100)])
    rerender({ boxes: [] })
    rerender({ boxes: [box('z', 4000, 4000)] })
    expect(result.current.viewport.x).toBeGreaterThan(3000)
  })
})
