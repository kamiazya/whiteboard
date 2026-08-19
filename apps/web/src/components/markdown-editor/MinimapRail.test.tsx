import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MinimapRail } from './MinimapRail.js'

afterEach(cleanup)

const blocks = [
  { x: 0, y: 0, w: 400, h: 100 },
  { x: 0, y: 120, w: 200, h: 80 },
]

/**
 * jsdom reports every element as zero-sized and ships no ResizeObserver, so
 * the rail would compute an empty geometry and assert nothing. Both are
 * stubbed to a fixed height — the arithmetic itself is covered by
 * rail-geometry.test.ts; what these tests are for is the wiring.
 */
const RAIL_HEIGHT = 200

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(RAIL_HEIGHT)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0,
    left: 0,
    right: 56,
    bottom: RAIL_HEIGHT,
    width: 56,
    height: RAIL_HEIGHT,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderRail(overrides: Partial<React.ComponentProps<typeof MinimapRail>> = {}) {
  const onSeek = overrides.onSeek ?? vi.fn()
  // jsdom implements no pointer capture at all, so the component's own
  // capture calls would throw before the handler under test ran.
  HTMLElement.prototype.setPointerCapture = () => undefined
  HTMLElement.prototype.hasPointerCapture = () => false
  const view = render(
    <MinimapRail
      blocks={overrides.blocks ?? blocks}
      viewport={overrides.viewport ?? { top: 0, height: 100 }}
      onSeek={onSeek}
    />,
  )
  return { ...view, onSeek }
}

describe('MinimapRail', () => {
  it('draws one bar per block', () => {
    const { container } = renderRail()
    const rail = container.querySelector('[data-testid="markdown-minimap-rail"]')
    // The viewport marker is the one child that is not a block.
    expect(rail?.children).toHaveLength(blocks.length + 1)
  })

  it('marks the visible slice', () => {
    const { getByTestId } = renderRail({ viewport: { top: 100, height: 100 } })
    // Content is 0..200 and the rail is 200 tall, so the mapping is 1:1.
    expect(getByTestId('markdown-minimap-viewport').style.top).toBe('100px')
  })

  it('seeks to the document position under a press', () => {
    const { getByTestId, onSeek } = renderRail()
    fireEvent.pointerDown(getByTestId('markdown-minimap-rail'), { clientY: 50, pointerId: 1 })
    expect(onSeek).toHaveBeenCalledWith(50)
  })

  // A drag that leaves the rail keeps scrolling, which is what a scrollbar
  // does; stopping at the edge would feel like a dropped gesture.
  it('keeps seeking while the pointer is captured', () => {
    const { getByTestId, onSeek } = renderRail()
    const rail = getByTestId('markdown-minimap-rail')
    // jsdom has no real pointer capture; model the captured state.
    rail.hasPointerCapture = () => true
    rail.setPointerCapture = () => undefined

    fireEvent.pointerDown(rail, { clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(rail, { clientY: 180, pointerId: 1 })

    expect(onSeek).toHaveBeenLastCalledWith(180)
  })

  it('ignores a move that is not part of a drag', () => {
    const { getByTestId, onSeek } = renderRail()
    const rail = getByTestId('markdown-minimap-rail')
    rail.hasPointerCapture = () => false

    fireEvent.pointerMove(rail, { clientY: 120, pointerId: 1 })

    expect(onSeek).not.toHaveBeenCalled()
  })

  // The rail duplicates scrolling the panes already expose; announcing every
  // block to a screen reader would be noise, not an alternative route.
  it('is hidden from assistive technology', () => {
    const { getByTestId } = renderRail()
    expect(getByTestId('markdown-minimap-rail').getAttribute('aria-hidden')).toBe('true')
  })

  it('renders nothing but the marker for an empty document', () => {
    const { container } = renderRail({ blocks: [] })
    const rail = container.querySelector('[data-testid="markdown-minimap-rail"]')
    expect(rail?.children).toHaveLength(1)
  })
})
