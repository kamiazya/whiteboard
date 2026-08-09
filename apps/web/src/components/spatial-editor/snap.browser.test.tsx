// Snapping in the editor. The geometry is unit-tested in snap.test.ts; this
// pins the wiring: that a dragged node actually lands on the snapped
// position, that the guide is drawn, that Cmd/Ctrl suspends it, and that a
// node never snaps to something travelling with it.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// `a` sits OFF the grid on purpose: a position that is already a grid
// multiple would leave every assertion ambiguous between the node candidate
// and the lattice.
const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 137, y: 113, width: 100, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 400, y: 400, width: 100, height: 60, text: 'B' },
  ],
  edges: [],
}

function makeHost(canvas0: SpatialCanvas = initial, lockedNodes: readonly string[] = []) {
  const latest: { canvas: SpatialCanvas } = { canvas: canvas0 }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(canvas0)
    latest.canvas = canvas
    return (
      <div style={{ width: 900, height: 700 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
          lockedNodeIds={new Set(lockedNodes)}
          onToggleNodeLock={() => {}}
        />
      </div>
    )
  }
  return { Host, latest }
}

const rootOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

/** Drag from one canvas-space point to another, optionally holding Cmd. */
function drag(
  root: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
  modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {},
) {
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + from.x,
    clientY: r.top + from.y,
  })
  fireEvent.pointerMove(root, {
    pointerId: 1,
    clientX: r.left + to.x,
    clientY: r.top + to.y,
    ...modifiers,
  })
  fireEvent.pointerUp(root, {
    pointerId: 1,
    clientX: r.left + to.x,
    clientY: r.top + to.y,
    ...modifiers,
  })
}

const byId = (canvas: SpatialCanvas, id: string) => canvas.nodes.find((node) => node.id === id)!

// Grab `b` at its centre (450, 430) and release 265 to the left, which puts
// its un-snapped left edge at 135: 2 from `a`'s edge at 137, and 5 from the
// grid line at 140. The node candidate is closer, so it wins.
const GRAB = { x: 450, y: 430 }
const DROP_NEAR_A = { x: 185, y: 430 }

it('lands a dragged node on a near-miss neighbour edge instead of where the pointer stopped', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  drag(rootOf(container), GRAB, DROP_NEAR_A)

  expect(byId(latest.canvas, 'b').x).toBe(137)
  // The other axis never moved, so it must come back untouched — the two
  // axes snap independently and 400 is already on the grid.
  expect(byId(latest.canvas, 'b').y).toBe(400)
})

it('draws the guide that justifies the snap while the drag is in flight', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + GRAB.x,
    clientY: r.top + GRAB.y,
  })
  fireEvent.pointerMove(root, {
    pointerId: 1,
    clientX: r.left + DROP_NEAR_A.x,
    clientY: r.top + DROP_NEAR_A.y,
  })

  const guide = container.querySelector('[data-testid="snap-guides"] [data-axis="x"]')
  expect(guide).toBeTruthy()
  expect(guide?.getAttribute('x1')).toBe('137')

  // A guide that outlived its gesture would be a permanent stray line.
  fireEvent.pointerUp(root, {
    pointerId: 1,
    clientX: r.left + DROP_NEAR_A.x,
    clientY: r.top + DROP_NEAR_A.y,
  })
  expect(container.querySelector('[data-testid="snap-guides"]')).toBeNull()
})

// Both modifiers, because the suspension is claimed for Cmd AND Ctrl and the
// two reach the handler through different event fields — testing one would
// leave the other free to regress on the platform that uses it.
it.each([
  ['Cmd', { metaKey: true }],
  ['Ctrl', { ctrlKey: true }],
] as const)('places the node exactly where the pointer stopped while %s is held', (_name, mod) => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  drag(rootOf(container), GRAB, DROP_NEAR_A, mod)

  expect(byId(latest.canvas, 'b').x).toBe(135)
})

it('snaps to the grid when no neighbour edge is in range', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  // Drop far from `a`: the left edge would be 603, and only the lattice is
  // near enough to attract.
  drag(rootOf(container), GRAB, { x: 653, y: 430 })

  expect(byId(latest.canvas, 'b').x).toBe(600)
})

const framedCanvas: SpatialCanvas = {
  nodes: [
    { id: 'frame', type: 'group', x: 407, y: 400, width: 200, height: 200, label: 'F' },
    // Sits 5 inside the frame's left edge — close enough to attract.
    { id: 'inner', type: 'text', x: 412, y: 460, width: 60, height: 40, text: 'I' },
  ],
  edges: [],
}
// Grab the frame chrome above `inner` and move 3 right. 410 is 10 from the
// nearest grid line, so only the member can decide where this lands.
const FRAME_GRAB = { x: 450, y: 420 }
const FRAME_DROP = { x: 453, y: 420 }

it('never snaps a group frame to a member it is carrying', () => {
  const { Host, latest } = makeHost(framedCanvas)
  const { container } = render(<Host />)

  drag(rootOf(container), FRAME_GRAB, FRAME_DROP)

  expect(byId(latest.canvas, 'frame').x).toBe(410)
})

it('DOES snap a group frame to a LOCKED member, which stays put', () => {
  // Containment is geometric, but the commit path refuses to move a locked
  // member with its frame. So a locked member is stationary content, not
  // something travelling with the drag — excluding it would throw away a
  // real alignment target.
  const { Host, latest } = makeHost(framedCanvas, ['inner'])
  const { container } = render(<Host />)

  drag(rootOf(container), FRAME_GRAB, FRAME_DROP)

  expect(byId(latest.canvas, 'frame').x).toBe(412)
  // ...and the lock still holds: the member did not travel.
  expect(byId(latest.canvas, 'inner').x).toBe(412)
})
