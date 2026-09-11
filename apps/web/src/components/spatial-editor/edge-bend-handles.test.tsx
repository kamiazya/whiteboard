// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EdgeBendHandles, ghostPresses } from './EdgeBendHandles.js'

const straight = [
  { x: 0, y: 0 },
  { x: 400, y: 0 },
]

describe('ghost presses', () => {
  it('offers two per drawn run, and neither is the midpoint the label owns', () => {
    // The midpoint is where an edge's label sits and where double-pressing
    // opens its editor; a ghost there swallows the second press.
    const ghosts = ghostPresses(straight, [], 1)
    // Float arithmetic, so the thirds are compared with a tolerance rather
    // than pinned to a literal that depends on how they were derived.
    expect(ghosts).toHaveLength(2)
    expect(ghosts[0]?.at.x).toBeCloseTo(400 / 3)
    expect(ghosts[1]?.at.x).toBeCloseTo(800 / 3)
    expect(ghosts.every((ghost) => ghost.at.y === 0)).toBe(true)
    // And neither is the midpoint.
    expect(ghosts.some((ghost) => Math.abs(ghost.at.x - 200) < 1)).toBe(false)
  })

  it('hands over the list with the new point already inserted, in path order', () => {
    // Two stored bends make three runs, and the middle one inserts BETWEEN
    // them — the index is what the reducer moves, so getting it wrong
    // reorders the line rather than bending it.
    const path = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 400, y: 0 },
    ]
    const stored = [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
    ]
    // Two ghosts per run, so the middle run's pair is entries 2 and 3.
    const middle = ghostPresses(path, stored, 1)[2]
    expect(middle?.index).toBe(1)
    expect(middle?.waypoints).toHaveLength(3)
    expect(middle?.waypoints[0]).toEqual({ x: 100, y: 100 })
    expect(middle?.waypoints[1]?.x).toBeCloseTo(100 + 200 / 3)
    expect(middle?.waypoints[2]).toEqual({ x: 300, y: 100 })
  })

  it('skips a run too short to aim at, and shortens with zoom rather than with the canvas', () => {
    const stub = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ]
    expect(ghostPresses(stub, [], 1)).toHaveLength(0)
    // Zoomed out, the same 20 canvas units are fewer screen pixels, so it
    // stays unaimable; zoomed in they are plenty.
    expect(ghostPresses(stub, [], 0.5)).toHaveLength(0)
    expect(ghostPresses(stub, [], 4)).toHaveLength(2)
  })
})

describe('the handles', () => {
  it('draws one grab handle per stored bend and reports the press', () => {
    const onPress = vi.fn()
    const stored = [{ x: 200, y: 120 }]
    const { getAllByTestId } = render(
      <EdgeBendHandles
        path={[{ x: 0, y: 0 }, ...stored, { x: 400, y: 0 }]}
        stored={stored}
        zoom={1}
        onPress={onPress}
        onRemove={vi.fn()}
        onNudge={vi.fn()}
      />,
    )
    const handles = getAllByTestId('edge-bend-handle')
    expect(handles).toHaveLength(1)
    handles[0]?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(onPress).toHaveBeenCalledTimes(1)
    expect(onPress.mock.calls[0]?.[0]).toEqual({ waypoints: stored, index: 0 })
  })

  it('removes a bend on a double press', () => {
    const onRemove = vi.fn()
    const stored = [{ x: 200, y: 120 }]
    const { getAllByTestId } = render(
      <EdgeBendHandles
        path={[{ x: 0, y: 0 }, ...stored, { x: 400, y: 0 }]}
        stored={stored}
        zoom={1}
        onPress={vi.fn()}
        onRemove={onRemove}
        onNudge={vi.fn()}
      />,
    )
    getAllByTestId('edge-bend-handle')[0]?.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true }),
    )
    expect(onRemove).toHaveBeenCalledWith(0)
  })

  it('scales a handle down as the canvas is zoomed in, so it stays one size on screen', () => {
    const stored = [{ x: 200, y: 120 }]
    // Scoped to each render's OWN container: testing-library's queries are
    // bound to document.body, so a second render would answer with the
    // first's handle and the comparison would read as "zoom does nothing".
    const at = (zoom: number) =>
      render(
        <EdgeBendHandles
          path={[{ x: 0, y: 0 }, ...stored, { x: 400, y: 0 }]}
          stored={stored}
          zoom={zoom}
          onPress={vi.fn()}
          onRemove={vi.fn()}
          onNudge={vi.fn()}
        />,
      )
        .container.querySelector('[data-testid="edge-bend-handle"]')
        ?.getAttribute('r')
    expect(Number(at(2))).toBeCloseTo(Number(at(1)) / 2)
  })
})

describe('the keyboard', () => {
  const renderOne = (onNudge = vi.fn(), onRemove = vi.fn()) => {
    const stored = [{ x: 200, y: 120 }]
    const { container } = render(
      <EdgeBendHandles
        path={[{ x: 0, y: 0 }, ...stored, { x: 400, y: 0 }]}
        stored={stored}
        zoom={1}
        onPress={vi.fn()}
        onRemove={onRemove}
        onNudge={onNudge}
      />,
    )
    return {
      handle: container.querySelector('[data-testid="edge-bend-handle"]') as Element,
      onNudge,
      onRemove,
    }
  }

  it('offers the handle to focus, and says what it is', () => {
    const { handle } = renderOne()
    expect(handle.getAttribute('tabindex')).toBe('0')
    expect(handle.getAttribute('role')).toBe('button')
    expect(handle.getAttribute('aria-label')).toBe('Bend 1 of the connection')
  })

  it('nudges on an arrow key, further with Shift', () => {
    const { handle, onNudge } = renderOne()
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(onNudge).toHaveBeenLastCalledWith(0, 1, 0)
    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, shiftKey: true }),
    )
    expect(onNudge).toHaveBeenLastCalledWith(0, 0, -10)
  })

  it('removes on Delete, and keeps the key from reaching the canvas', () => {
    // The canvas answers Delete by removing the SELECTED edge, so a bend
    // that let the key through would delete the line it belongs to.
    const { handle, onRemove } = renderOne()
    const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
    const seenByCanvas = vi.fn()
    document.body.addEventListener('keydown', seenByCanvas)
    handle.dispatchEvent(event)
    document.body.removeEventListener('keydown', seenByCanvas)
    expect(onRemove).toHaveBeenCalledWith(0)
    expect(seenByCanvas).not.toHaveBeenCalled()
  })
})
