// Live-drag side tracking: edges attached to the CARRIED node re-pick their
// sides every frame (the local heuristic), so the mid-drag route matches
// where the drop will land instead of pointing out of the gesture-start
// side long after the geometry stopped supporting it. Bystander edges stay
// frozen for route stability; the drop still runs the full optimization.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const polylines = (root: ParentNode) =>
  [...root.querySelectorAll('polyline')].map((p) => p.getAttribute('points') ?? '')

it('a carried edge re-sides mid-drag to match the drop result', async () => {
  // T top-left, D below it, edge T -> D. Dragging D far to T's right makes
  // the right side of T the natural exit; frozen-at-start sides kept the
  // BOTTOM exit and produced a mid-drag route the drop then jumped away
  // from.
  const initial: SpatialCanvas = {
    nodes: [
      { id: 't', type: 'text', x: 60, y: 20, width: 160, height: 60, text: 'T' },
      { id: 'd', type: 'text', x: 80, y: 480, width: 160, height: 90, text: 'D' },
    ],
    edges: [{ id: 'e1', fromNode: 't', toNode: 'd' }],
    'x-whiteboard': { edgeRouting: { style: 'orthogonal' } },
  }
  const latest = { canvas: initial }
  function Host() {
    const [canvas, setCanvas] = useState(initial)
    latest.canvas = canvas
    return (
      <div style={{ width: 900, height: 700 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
        />
      </div>
    )
  }
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()
  await new Promise((res) => setTimeout(res, 200))

  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 160,
    clientY: r.top + 525,
  })
  fireEvent.pointerMove(root, { pointerId: 1, clientX: r.left + 170, clientY: r.top + 529 })
  fireEvent.pointerMove(root, { pointerId: 1, clientX: r.left + 560, clientY: r.top + 320 })
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="live-edges"]')).toBeTruthy()
  })
  const live = container.querySelector('[data-testid="live-edges"]') as HTMLElement
  const livePts = polylines(live)
  expect(livePts).toHaveLength(1)
  // Fresh side choice: the live route leaves T's RIGHT side (x = 220), the
  // same side the drop will pick — not the stale bottom exit (140,80).
  expect((livePts[0] as string).startsWith('220,')).toBe(true)

  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 560, clientY: r.top + 320 })
  await new Promise((res) => setTimeout(res, 250))
  const after = polylines(root)
  expect(after).toHaveLength(1)
  // Drop parity: committed route leaves the same side the live preview showed.
  expect((after[0] as string).startsWith('220,')).toBe(true)
})

it('bystander edges stay frozen while an unrelated node is dragged', async () => {
  // A -> B vertical edge; unrelated node D dragged around on the right.
  // The bystander's sides must not flap mid-drag.
  const initial: SpatialCanvas = {
    nodes: [
      { id: 'a', type: 'text', x: 260, y: 0, width: 120, height: 60, text: 'A' },
      { id: 'b', type: 'text', x: 260, y: 520, width: 120, height: 60, text: 'B' },
      { id: 'd', type: 'text', x: 620, y: 240, width: 160, height: 120, text: 'D' },
    ],
    edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
    'x-whiteboard': { edgeRouting: { style: 'orthogonal' } },
  }
  function Host() {
    const [canvas, setCanvas] = useState(initial)
    return (
      <div style={{ width: 900, height: 700 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
        />
      </div>
    )
  }
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()
  await new Promise((res) => setTimeout(res, 200))

  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 700,
    clientY: r.top + 300,
  })
  fireEvent.pointerMove(root, { pointerId: 1, clientX: r.left + 690, clientY: r.top + 304 })
  fireEvent.pointerMove(root, { pointerId: 1, clientX: r.left + 660, clientY: r.top + 500 })
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="live-edges"]')).toBeTruthy()
  })
  const live = container.querySelector('[data-testid="live-edges"]') as HTMLElement
  const livePts = polylines(live)
  expect(livePts).toHaveLength(1)
  // Still the committed top-to-bottom exit: starts at A's bottom (320,60).
  expect((livePts[0] as string).startsWith('320,60')).toBe(true)
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 660, clientY: r.top + 500 })
})
