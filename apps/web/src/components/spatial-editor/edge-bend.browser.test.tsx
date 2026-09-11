// Bending a connection by hand. The router that draws the bends lives in
// the bundled plugin (`visual.path/v0`), so this is what says a stored
// point survives the whole way from a pointer drag to the ink: a reducer
// test cannot see the layout, and a layout test cannot see the gesture.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { VISUAL_PATH_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const nodes: SpatialCanvas['nodes'] = [
  { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'A' },
  { id: 'b', type: 'text', x: 500, y: 100, width: 120, height: 60, text: 'B' },
]

const board = (waypoints?: readonly { x: number; y: number }[]): SpatialCanvas => ({
  nodes,
  edges: [
    {
      id: 'e1',
      fromNode: 'a',
      toNode: 'b',
      ...(waypoints === undefined ? {} : { facets: { [VISUAL_PATH_KEY]: { waypoints } } }),
    },
  ],
})

function makeHost(start: SpatialCanvas) {
  const latest: { canvas: SpatialCanvas } = { canvas: start }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 900, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
        />
      </div>
    )
  }
  return { Host, latest }
}

const storedBends = (canvas: SpatialCanvas) =>
  (
    canvas.edges[0]?.facets?.[VISUAL_PATH_KEY] as
      | { waypoints?: readonly { x: number; y: number }[] }
      | undefined
  )?.waypoints

/**
 * A CLIENT point actually ON the drawn line, taken through the polyline's
 * own geometry rather than from its bounding box: a bent edge's box centre
 * sits off the ink, which selects nothing and reads as a broken hit-test.
 */
function pointOnEdge(container: HTMLElement): { clientX: number; clientY: number } {
  const polyline = container.querySelector(
    '[data-testid="spatial-editor"] svg polyline',
  ) as SVGPolylineElement
  const at = polyline.getPointAtLength(polyline.getTotalLength() / 2)
  const matrix = polyline.getScreenCTM() as DOMMatrix
  const mapped = at.matrixTransform(matrix)
  return { clientX: mapped.x, clientY: mapped.y }
}

const centre = (element: Element): { clientX: number; clientY: number } => {
  const rect = element.getBoundingClientRect()
  return { clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }
}

/**
 * A tick between every dispatch, so React commits the state the NEXT
 * handler closes over. Firing a whole press-move-release synchronously
 * runs all three against the render from before the press: the reducer sees
 * an idle gesture at the release and commits nothing, which reads exactly
 * like the gesture not being wired up. Real input always has frames
 * between.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const press = async (target: Element, at: { clientX: number; clientY: number }) => {
  target.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, button: 0, ...at }),
  )
  await tick()
}

const moveTo = async (target: Element, at: { clientX: number; clientY: number }) => {
  target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, ...at }))
  await tick()
}

const release = async (target: Element, at: { clientX: number; clientY: number }) => {
  target.dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, pointerId: 7, button: 0, ...at }),
  )
  await tick()
}

async function selectTheEdge(container: HTMLElement) {
  const root = rootOf(container)
  const at = pointOnEdge(container)
  await press(root, at)
  await release(root, at)
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )
}

const waitForOne = async (container: HTMLElement, testId: string) =>
  await vi.waitFor(() => {
    const found = container.querySelector(`[data-testid="${testId}"]`)
    expect(found).not.toBeNull()
    return found as Element
  })

it('dragging the ghost handle on a straight run stores a bend the line is drawn through', async () => {
  const { Host, latest } = makeHost(board())
  const { container } = render(<Host />)
  await selectTheEdge(container)

  const ghost = await waitForOne(container, 'edge-bend-ghost')
  const from = centre(ghost)
  const to = { clientX: from.clientX, clientY: from.clientY + 90 }
  await press(ghost, from)
  const root = rootOf(container)
  await moveTo(root, to)
  await release(root, to)

  await vi.waitFor(() => expect(storedBends(latest.canvas)).toHaveLength(1))
  // The drawn line now turns: a straight A-to-B edge has two points.
  await vi.waitFor(() => {
    const polyline = container.querySelector(
      '[data-testid="spatial-editor"] svg polyline',
    ) as SVGPolylineElement
    expect(polyline.getAttribute('points')?.trim().split(/\s+/).length).toBeGreaterThan(2)
  })
})

it('a stored bend gets a grab handle, and a double press takes it back out', async () => {
  const { Host, latest } = makeHost(board([{ x: 320, y: 300 }]))
  const { container } = render(<Host />)
  await selectTheEdge(container)

  const handle = await waitForOne(container, 'edge-bend-handle')
  handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await vi.waitFor(() => expect(storedBends(latest.canvas)).toBeUndefined())
})

it('an arrow key on a focused bend moves it, so the affordance is not pointer-only', async () => {
  const { Host, latest } = makeHost(board([{ x: 320, y: 300 }]))
  const { container } = render(<Host />)
  await selectTheEdge(container)

  const handle = (await waitForOne(container, 'edge-bend-handle')) as SVGElement
  handle.focus()
  handle.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, shiftKey: true }),
  )
  await vi.waitFor(() => expect(storedBends(latest.canvas)?.[0]).toEqual({ x: 320, y: 310 }))
  // The connection is still there: Delete-adjacent keys on a bend must
  // never reach the canvas's own edge deletion.
  expect(latest.canvas.edges).toHaveLength(1)
})
