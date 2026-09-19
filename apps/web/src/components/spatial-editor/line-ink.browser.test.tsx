// Ink in the editor, end to end in a real browser: drag a connection off a
// node, release over empty canvas, and a LINE is drawn to the release point —
// then click it and press Delete to take it off again.
//
// The three steps go together on purpose. Authoring alone would ship an
// editor where a stray line can only be removed by undo, and selection alone
// would be a control for something no gesture can make.
//
// An edge is a RELATION and cannot end in empty space (ADR-0038 decision 2);
// ink that can is a LINE, whose ends are a `{kind:'node'}|{kind:'point'}`
// union in the canvas's own `lines` collection. Before this the gesture
// cancelled here, because there was nothing an edge could have become.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 200, y: 200, width: 120, height: 80, text: 'source' })],
  edges: [],
}

function makeHost() {
  // The host keeps the LATEST canvas rather than the test reading React
  // state: what is asserted is what the editor handed back through onChange,
  // which is the value that would have been persisted.
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
 * Drags off the source node's east connect handle and releases at `to`, in
 * root-relative pixels.
 *
 * The handle only exists once the node is selected, so the click comes first
 * and is awaited through the handle appearing rather than through a delay.
 *
 * Coordinates are root-relative and the editor's viewport is identity at
 * rest, so they are also canvas coordinates: the source box really does
 * occupy 200,200 120x80 on screen. Measured rather than assumed.
 */
async function drawLineTo(container: HTMLElement, to: [number, number]) {
  const root = rootOf(container)
  await userEvent.click(root, { position: { x: 260, y: 240 } })
  // The east handle carries the bare testid; only n/s/w are suffixed.
  const handle = page.getByTestId('connect-handle')
  await expect.element(handle).toBeInTheDocument()
  const rect = root.getBoundingClientRect()
  const at = (x: number, y: number) => ({ clientX: rect.left + x, clientY: rect.top + y })
  // Awaited between dispatches, and that is load-bearing rather than
  // stylistic: `dispatchEvent` is synchronous, so firing down and up in one
  // turn lets the release be reduced before React has committed the
  // `connecting` state the press set — and the gesture answers from `idle`,
  // minting nothing. Measured: without the awaits this drew no line and read
  // exactly like the mint not working.
  await handle
    .element()
    .dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 91, button: 0, ...at(320, 240) }),
    )
  await root.dispatchEvent(
    new PointerEvent('pointermove', { bubbles: true, pointerId: 91, buttons: 1, ...at(...to) }),
  )
  await root.dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, pointerId: 91, ...at(...to) }),
  )
  return { root, rect }
}

it('draws a line to the release point, then deletes it once selected', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  const { root } = await drawLineTo(container, [600, 450])

  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(1)
  const line = latest.canvas.lines?.[0]
  expect(line?.from).toEqual({ kind: 'node', node: 'a' })
  // A free end, which is the whole reason this is a line and not an edge.
  expect(line?.to.kind).toBe('point')
  // No edge was invented alongside it: ink is not a relation.
  expect(latest.canvas.edges).toEqual([])

  // Click the drawn ink to select it. The scene hands an edge and a line out
  // the same way — canvas-render routes `[...edges, ...lines]` and both come
  // back as `kind: 'edge'` scene nodes carrying their own id — so the
  // existing hit-test finds a line without knowing it is one. Pressing at a
  // point ON the drawn path rather than at its midpoint by arithmetic: the
  // route is the renderer's, not this test's, so the press is aimed at a
  // coordinate the path really passes through.
  await userEvent.click(root, { position: { x: 460, y: 345 } })
  await userEvent.keyboard('{Delete}')

  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(0)
  // The node it started on is untouched — deleting ink is not deleting what
  // the ink was drawn from.
  expect(latest.canvas.nodes).toHaveLength(1)
})

it('cancels instead of drawing when the release lands back on the source node', async () => {
  // The connect handle is drawn ON the node and overhangs it, so a press and
  // release that never left the box would otherwise mint zero-length ink —
  // invisible, and impossible to click in order to remove.
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  await drawLineTo(container, [280, 240])

  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(0)
  expect(latest.canvas.edges).toEqual([])
})
