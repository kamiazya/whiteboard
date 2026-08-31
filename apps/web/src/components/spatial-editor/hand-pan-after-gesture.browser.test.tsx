/**
 * The two dead-hand-tool cases `hand-pan-gesture-history.property` shrank to,
 * pinned as examples. Both are "I pressed and dragged and the canvas did not
 * follow", and neither depends on where the finger landed — which is why a
 * property over press POSITIONS could not see either of them.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const board: SpatialCanvas = {
  nodes: [{ id: 'a', type: 'text', x: 40, y: 40, width: 200, height: 100, text: 'a' }],
  edges: [],
}

function Host() {
  const [canvas, setCanvas] = useState(board)
  return (
    <div style={{ width: 390, height: 780 }}>
      <SpatialEditor defaultTool="hand" canvas={canvas} onChange={setCanvas} theme="light" />
    </div>
  )
}

function mount() {
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const layer = container.querySelector('[data-testid="viewport-transform"]') as HTMLElement
  return { root, layer, rect: root.getBoundingClientRect() }
}

function ev(
  target: Element,
  kind: 'down' | 'move' | 'up',
  id: number,
  x: number,
  y: number,
  isPrimary: boolean,
) {
  const init = {
    pointerId: id,
    pointerType: 'touch',
    isPrimary,
    button: 0,
    buttons: kind === 'up' ? 0 : 1,
    clientX: x,
    clientY: y,
  }
  if (kind === 'down') fireEvent.pointerDown(target, init)
  else if (kind === 'move') fireEvent.pointerMove(target, init)
  else fireEvent.pointerUp(target, init)
}

function readTransform(layer: HTMLElement) {
  const m = layer.style.transform.match(
    /scale\(([-\d.e+]+)\) translate\(([-\d.e+]+)px, ([-\d.e+]+)px\)/,
  )
  if (m === null) throw new Error(`unexpected transform: ${layer.style.transform}`)
  return { zoom: Number(m[1]), x: Number(m[2]), y: Number(m[3]) }
}

/** One finger down, moved by `by`, released. Answers the viewport's response. */
function handDrag(
  root: HTMLElement,
  layer: HTMLElement,
  at: { x: number; y: number },
  by: { x: number; y: number },
) {
  const before = readTransform(layer)
  ev(root, 'down', 1, at.x, at.y, true)
  ev(root, 'move', 1, at.x + by.x, at.y + by.y, true)
  ev(root, 'up', 1, at.x + by.x, at.y + by.y, true)
  const after = readTransform(layer)
  return {
    dx: Math.round((after.x - before.x) * 100) / 100 + 0,
    dy: Math.round((after.y - before.y) * 100) / 100 + 0,
    zoom: after.zoom / before.zoom,
  }
}

it('a tap, then a drag from elsewhere, pans rather than reading as a double press', () => {
  const { root, layer, rect } = mount()

  // A tap in one corner...
  ev(root, 'down', 1, rect.left + 70, rect.top + 180, true)
  ev(root, 'up', 1, rect.left + 70, rect.top + 180, true)
  // ...then, well inside the double-press WINDOW but 420px away, a drag.
  const at = { x: rect.left + 300, y: rect.top + 600 }
  expect(Math.hypot(300 - 70, 600 - 180)).toBeGreaterThan(400)

  expect(handDrag(root, layer, at, { x: 24, y: -18 })).toEqual({ dx: 24, dy: -18, zoom: 1 })
})

it('a finger whose release the root never saw does not turn the next drag into a pinch', () => {
  const { root, layer, rect } = mount()

  // A second finger goes down on the canvas and is released over something
  // outside the editor, so the root's handler never hears about it. Real
  // phones do this; `document.body` sits above the root, so an event there
  // reaches nothing the editor listens on.
  ev(root, 'down', 7, rect.left + 100, rect.top + 200, false)
  ev(document.body, 'up', 7, 2, 2, false)

  // The next touch is the first of a new sequence, so the browser marks it
  // primary — which is exactly the evidence that nothing else is down.
  const at = { x: rect.left + 300, y: rect.top + 600 }
  expect(handDrag(root, layer, at, { x: 24, y: -18 })).toEqual({ dx: 24, dy: -18, zoom: 1 })
})
