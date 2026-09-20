// Moving ink with the arrow keys, in a real browser.
//
// `element-verb-parity.test.ts` asked every verb of every element kind and
// found that a `CanvasLine` stores seven things a person could want changed
// while the editor wrote none of them: a stroke could be drawn, picked,
// banded, shift-added, ungrouped, locked and deleted, and after that it was
// fixed where it fell. This is the first of the two cheapest to close.
//
// The keyboard rather than a drag, deliberately: the drag machine is keyed on
// a node id, and giving it an ink arm is its own increment. The nudge is
// where `move-node` already comes from for a node selection, so a stroke
// joins the selection the rest of it already travels as.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

/** One arrow press, as `use-editor-keyboard.ts` declares it. */
const STEP = 8

const start: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 40, y: 40, width: 120, height: 80, text: 'note' })],
  edges: [],
  lines: [
    {
      id: 'l1',
      from: { kind: 'point', point: { x: 300, y: 200 } },
      to: { kind: 'point', point: { x: 500, y: 400 } },
    },
  ],
}

function makeHost(canvas: SpatialCanvas = start) {
  const latest = { canvas }
  function Host() {
    const [current, setCurrent] = useState<SpatialCanvas>(canvas)
    latest.canvas = current
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={current}
          onChange={(next) => setCurrent(next)}
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
 * The stroke runs from 300,200 to 500,400 and the viewport is identity at
 * rest, so its midpoint really is under 400,300 on screen. Pressing a point
 * the drawn path passes through rather than computing one: the route belongs
 * to the renderer.
 */
async function selectTheStroke(container: HTMLElement) {
  const root = rootOf(container)
  await userEvent.click(root, { position: { x: 400, y: 300 } })
  return root
}

it('moves a selected stroke, both ends together', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  await selectTheStroke(container)
  await userEvent.keyboard('{ArrowRight}')

  await expect
    .poll(() => latest.canvas.lines?.[0]?.from)
    .toEqual({ kind: 'point', point: { x: 300 + STEP, y: 200 } })
  // Both ends, or the stroke is stretched rather than moved — the failure a
  // test on one end alone would pass over.
  expect(latest.canvas.lines?.[0]?.to).toEqual({
    kind: 'point',
    point: { x: 500 + STEP, y: 400 },
  })
  // The board's other content is not dragged along by a press that selected
  // ink: the node keeps the position it was given.
  expect(latest.canvas.nodes[0]?.x).toBe(40)
})

it('leaves an end that is on a node attached to it', async () => {
  const { Host, latest } = makeHost({
    ...start,
    lines: [
      {
        id: 'l1',
        from: { kind: 'node', node: 'a' },
        to: { kind: 'point', point: { x: 500, y: 400 } },
      },
    ],
  })
  const { container } = render(<Host />)

  // This stroke runs from the node's box to the free point at 500,400. The
  // press is aimed just short of that free end rather than at a midpoint:
  // where the path leaves the node's silhouette is the router's business and
  // moves with the shape, while the last stretch runs at the free end
  // whatever the route did earlier.
  const root = rootOf(container)
  await userEvent.click(root, { position: { x: 488, y: 388 } })
  await userEvent.keyboard('{ArrowDown}')

  await expect
    .poll(() => latest.canvas.lines?.[0]?.to)
    .toEqual({ kind: 'point', point: { x: 500, y: 400 + STEP } })
  // The attachment is the whole point of that end, so the node carries it.
  expect(latest.canvas.lines?.[0]?.from).toEqual({ kind: 'node', node: 'a' })
})
