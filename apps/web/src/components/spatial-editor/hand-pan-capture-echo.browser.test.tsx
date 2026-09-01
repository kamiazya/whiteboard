/**
 * The phone bug, reproduced from its own flight-recorder trace
 * (2026-09-01, Android Chrome 151): a hand pan that starts ON A NODE dies
 * within two frames, while the finger keeps dragging and every move still
 * reaches the root.
 *
 * Mechanism: a REAL touch gives implicit pointer capture to the element
 * under the finger (Pointer Events, "implicit pointer capture") — a node's
 * SVG child, not the root. The editor then takes capture onto the root at
 * the first move, which is a capture TRANSFER: the child's
 * `lostpointercapture` bubbles to the root one frame later, and a handler
 * that only asks "is this pointer still down?" reads the transfer it
 * itself performed as a loss, cancels, and strands the pan under a moving
 * finger. Over empty canvas the implicit capture already sits on the root,
 * the transfer is a no-op, no event fires — which is why every report said
 * empty space always panned and nodes sometimes did not.
 *
 * Synthetic events get NO implicit capture, which is why three sessions of
 * simulation never saw this. The tests below dispatch the child's echo
 * explicitly — the exact event pattern the trace recorded.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const board: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 60, y: 60, width: 240, height: 140, text: 'node' }],
  edges: [],
}

function Host() {
  const [canvas, setCanvas] = useState(board)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="hand" canvas={canvas} onChange={setCanvas} theme="light" />
    </div>
  )
}

function translateOf(container: HTMLElement): { x: number; y: number } {
  const css = (container.querySelector('[data-testid="viewport-transform"]') as HTMLElement).style
    .transform
  const m = css.match(/translate\(([-\d.e+]+)px, ([-\d.e+]+)px\)/)
  if (m === null) throw new Error(`unexpected transform: ${css}`)
  return { x: Number(m[1]), y: Number(m[2]) }
}

function touch(target: Element, type: 'down' | 'move' | 'up', x: number, y: number) {
  const init = {
    pointerId: 9,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    buttons: type === 'up' ? 0 : 1,
    clientX: x,
    clientY: y,
  }
  if (type === 'down') fireEvent.pointerDown(target, init)
  else if (type === 'move') fireEvent.pointerMove(target, init)
  else fireEvent.pointerUp(target, init)
}

it('a pan pressed on a node survives the capture transfer its own first move performs', () => {
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const content = container.querySelector('[data-testid="canvas-content"]') as HTMLElement
  const child = content.querySelector('svg') ?? content
  const r = root.getBoundingClientRect()

  const before = translateOf(container)
  // Press ON the node's own element, as a finger over a node does.
  touch(child, 'down', r.left + 150, r.top + 120)
  touch(root, 'move', r.left + 160, r.top + 130)
  // The echo of the editor's own root.setPointerCapture: the implicitly
  // captured child loses capture TO the root, and its event bubbles up.
  fireEvent(child, new PointerEvent('lostpointercapture', { pointerId: 9, bubbles: true }))
  touch(root, 'move', r.left + 190, r.top + 160)
  touch(root, 'up', r.left + 190, r.top + 160)

  const after = translateOf(container)
  // The finger travelled +40/+40 in total; the canvas must have followed all
  // of it — on the trace this recorder caught, everything after the echo was
  // dropped on the floor.
  expect({ dx: after.x - before.x, dy: after.y - before.y }).toEqual({ dx: 40, dy: 40 })
})

it('the ROOT losing capture mid-pan still cancels: that one is a real loss', () => {
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()

  const before = translateOf(container)
  touch(root, 'down', r.left + 400, r.top + 400)
  touch(root, 'move', r.left + 410, r.top + 410)
  fireEvent(root, new PointerEvent('lostpointercapture', { pointerId: 9, bubbles: true }))
  // Whatever arrives after a genuine loss must not pan: the browser owns
  // the pointer now.
  touch(root, 'move', r.left + 470, r.top + 470)
  touch(root, 'up', r.left + 470, r.top + 470)

  const after = translateOf(container)
  expect({ dx: after.x - before.x, dy: after.y - before.y }).toEqual({ dx: 10, dy: 10 })
})
