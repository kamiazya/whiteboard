// Dragging ink with the pointer.
//
// The arrow keys could already nudge a stroke; the POINTER could not, and the
// reason was structural rather than an oversight: `gestures.ts` keys its
// moving state on a node id, so a press on ink fell through to the branch
// that starts a MARQUEE. Pressing a stroke and pulling therefore rubber-banded
// over it — the one gesture everybody tries first, doing something else.
//
// `moving-ink` is its own state rather than an arm of the node one, and the
// difference is the model's: a node moves to an absolute position computed
// from one origin, and ink has none, so `move-line` takes a delta.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const board: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 40, y: 40, width: 120, height: 60, text: 'note' })],
  edges: [],
  lines: [
    {
      id: 'l1',
      from: { kind: 'point', point: { x: 200, y: 300 } },
      to: { kind: 'point', point: { x: 500, y: 300 } },
    },
  ],
}

function makeHost(start: SpatialCanvas = board) {
  const latest = { canvas: start }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
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

const rootOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

/**
 * A tick between every dispatch, so React commits the state the NEXT handler
 * closes over — the same reason `edge-bend.browser.test.tsx` gives: firing a
 * whole press-move-release in one turn runs all three against the render from
 * before the press, and the release reduces from an idle gesture.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function dragFrom(
  root: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const rect = root.getBoundingClientRect()
  const at = (p: { x: number; y: number }) => ({
    clientX: rect.left + p.x,
    clientY: rect.top + p.y,
  })
  root.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      pointerId: 31,
      button: 0,
      isPrimary: true,
      ...at(from),
    }),
  )
  await tick()
  root.dispatchEvent(
    new PointerEvent('pointermove', { bubbles: true, pointerId: 31, buttons: 1, ...at(to) }),
  )
  await tick()
  root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 31, ...at(to) }))
  await tick()
}

it('drags a stroke to where the pointer let go', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  await dragFrom(root, { x: 350, y: 300 }, { x: 390, y: 260 })

  await vi.waitFor(() =>
    expect(latest.canvas.lines?.[0]?.from).toEqual({
      kind: 'point',
      point: { x: 240, y: 260 },
    }),
  )
  expect(latest.canvas.lines?.[0]?.to).toEqual({ kind: 'point', point: { x: 540, y: 260 } })
  // The press never started a band, which is what it used to do.
  expect(container.querySelector('[data-testid="marquee-rect"]')).toBeNull()
})

it('leaves a RELATION where it is, and bands over it as before', async () => {
  // An edge's path is routed from the boxes it joins, so there is no
  // geometry of its own to drag — `pointerdown-ink` drops it and the press
  // falls through to the marquee it always started.
  const withEdge: SpatialCanvas = {
    nodes: [
      textNode({ id: 'a', x: 100, y: 100, width: 120, height: 60, text: 'A' }),
      textNode({ id: 'b', x: 500, y: 100, width: 120, height: 60, text: 'B' }),
    ],
    edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' } }],
  }
  const { Host, latest } = makeHost(withEdge)
  const { container } = render(<Host />)
  const root = rootOf(container)

  await dragFrom(root, { x: 350, y: 130 }, { x: 390, y: 90 })

  expect(latest.canvas.edges[0]).toEqual({ id: 'e1', from: { node: 'a' }, to: { node: 'b' } })
  // And the boxes the edge joins are untouched: nothing was dragged.
  expect(latest.canvas.nodes[0]?.x).toBe(100)
})

it('a press that never travels still just selects', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  await dragFrom(root, { x: 350, y: 300 }, { x: 350, y: 300 })

  expect(latest.canvas.lines?.[0]?.from).toEqual({ kind: 'point', point: { x: 200, y: 300 } })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )
})
