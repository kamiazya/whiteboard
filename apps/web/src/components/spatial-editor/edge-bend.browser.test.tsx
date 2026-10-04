// Bending a connection by hand. This is what says a stored bend survives
// the whole way from a pointer drag to the ink: a reducer test cannot see
// the layout, and a layout test cannot see the gesture.

import { MAX_BENDS, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { tick } from '../../test-utils/async.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const nodes: SpatialCanvas['nodes'] = [
  textNode({ id: 'a', x: 100, y: 100, width: 120, height: 60, text: 'A' }),
  textNode({ id: 'b', x: 500, y: 100, width: 120, height: 60, text: 'B' }),
]

const board = (bends?: { x: number; y: number }[]): SpatialCanvas => ({
  nodes,
  edges: [
    {
      id: 'e1',
      from: { node: 'a' },
      to: { node: 'b' },
      ...(bends === undefined ? {} : { bends }),
    },
  ],
})

const SIZE = { width: 900, height: 600 }

const storedBends = (canvas: SpatialCanvas) => canvas.edges[0]?.bends

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
  const { Host, latest } = makeEditorHost({ initial: board(), size: SIZE })
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

// A zigzag between the two nodes, every leg long enough to be worth a ghost.
const zigzag = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    x: 240 + (i * 240) / MAX_BENDS,
    y: i % 2 === 0 ? 200 : 400,
  }))

it('a line one bend under the cap still offers ghosts, and one at the cap offers none', async () => {
  const under = makeEditorHost({ initial: board(zigzag(MAX_BENDS - 1)), size: SIZE })
  const first = render(<under.Host />)
  await selectTheEdge(first.container)
  await vi.waitFor(() =>
    expect(first.container.querySelectorAll('[data-testid="edge-bend-handle"]')).toHaveLength(
      MAX_BENDS - 1,
    ),
  )
  expect(first.container.querySelector('[data-testid="edge-bend-ghost"]')).not.toBeNull()
  first.unmount()

  const full = makeEditorHost({ initial: board(zigzag(MAX_BENDS)), size: SIZE })
  const second = render(<full.Host />)
  await selectTheEdge(second.container)
  // The grab handles are the subject being present; only then does the
  // absence of a ghost say anything.
  await vi.waitFor(() =>
    expect(second.container.querySelectorAll('[data-testid="edge-bend-handle"]')).toHaveLength(
      MAX_BENDS,
    ),
  )
  expect(second.container.querySelector('[data-testid="edge-bend-ghost"]')).toBeNull()
})

it('a stored bend gets a grab handle, and a double press takes it back out', async () => {
  const { Host, latest } = makeEditorHost({ initial: board([{ x: 320, y: 300 }]), size: SIZE })
  const { container } = render(<Host />)
  await selectTheEdge(container)

  const handle = await waitForOne(container, 'edge-bend-handle')
  handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await vi.waitFor(() => expect(storedBends(latest.canvas)).toBeUndefined())
})

it('an arrow key on a focused bend moves it, so the affordance is not pointer-only', async () => {
  const { Host, latest } = makeEditorHost({ initial: board([{ x: 320, y: 300 }]), size: SIZE })
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

it('bends a STROKE the same way, from the same handle', async () => {
  // A line stores its bends in the same field an edge does —
  // `bendsFieldSchema` is declared once and used by both — and the scene
  // hands the two out identically, so the affordance was already generic and
  // said it was not: the layer's prop named `CanvasEdge`, the reducer's
  // guard and its `storedWaypoints` read `canvas.edges`, and the editor
  // looked its selection up there too. A selected stroke got no handle at
  // all, and every one of those reads was correct for the collection it knew
  // about.
  const inkBoard: SpatialCanvas = {
    nodes,
    edges: [],
    lines: [
      {
        id: 'l1',
        from: { kind: 'point', point: { x: 160, y: 300 } },
        to: { kind: 'point', point: { x: 560, y: 300 } },
      },
    ],
  }
  const { Host, latest } = makeEditorHost({ initial: inkBoard, size: SIZE })
  const { container } = render(<Host />)
  await selectTheEdge(container)

  const ghost = await waitForOne(container, 'edge-bend-ghost')
  const from = centre(ghost)
  const to = { clientX: from.clientX, clientY: from.clientY + 90 }
  await press(ghost, from)
  const root = rootOf(container)
  await moveTo(root, to)
  await release(root, to)

  await vi.waitFor(() => expect(latest.canvas.lines?.[0]?.bends).toHaveLength(1))
  // The relation collection is untouched: the write went to the one the id
  // actually came from.
  expect(latest.canvas.edges).toEqual([])
})
