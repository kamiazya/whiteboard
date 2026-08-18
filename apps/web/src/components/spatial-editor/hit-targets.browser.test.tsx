// The gap between what a handle SHOWS (8px) and what it CATCHES (24px+).
//
// Every assertion here presses deliberately OUTSIDE the visible marker but
// inside the invisible hit shape — the exact press that used to fall
// through to the canvas and start a marquee instead of the resize the
// person aimed for.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 200, y: 150, width: 200, height: 100, text: 'hi' }],
  edges: [],
}

function makeHost() {
  const latest: { canvas: SpatialCanvas } = { canvas: initial }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
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

function selectNode(container: HTMLElement) {
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()
  // Node occupies root-local (200,150)-(400,250) at identity viewport.
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 300,
    clientY: r.top + 200,
  })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 300, clientY: r.top + 200 })
  return { root, r }
}

/**
 * The load-bearing detail: the element PRESSED is whatever the browser's
 * own hit test finds at the coordinates, not an element this test picked.
 * fireEvent on a queried element would deliver the press no matter where
 * the coordinates fall, which asserts nothing about hit size — a hit box
 * shrunk back to 8px kept the first version of these tests green.
 */
function pressAt(root: HTMLElement, at: [number, number]): Element {
  const r = root.getBoundingClientRect()
  const target = document.elementFromPoint(r.left + at[0], r.top + at[1])
  if (target === null) throw new Error(`nothing at ${at[0]},${at[1]}`)
  fireEvent.pointerDown(target, {
    button: 0,
    pointerId: 2,
    clientX: r.left + at[0],
    clientY: r.top + at[1],
  })
  return target
}

function dragFromScreenPoint(root: HTMLElement, from: [number, number], to: [number, number]) {
  const r = root.getBoundingClientRect()
  pressAt(root, from)
  fireEvent.pointerMove(root, { pointerId: 2, clientX: r.left + to[0], clientY: r.top + to[1] })
  fireEvent.pointerUp(root, { pointerId: 2, clientX: r.left + to[0], clientY: r.top + to[1] })
}

it('a press 10px OUTSIDE the corner marker still resizes from that corner', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const { root } = selectNode(container)

  // (410,260) is 10px past the se corner (400,250): outside the old 8px
  // marker, inside the new 24px hit box.
  dragFromScreenPoint(root, [410, 260], [440, 290])

  const node = latest.canvas.nodes[0]
  if (node === undefined) throw new Error('node missing')
  expect(node.width).toBeGreaterThan(200)
  expect(node.height).toBeGreaterThan(100)
})

it('the whole edge is a grab: a press mid-edge, away from any marker, resizes that side', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const { root } = selectNode(container)

  // On the east edge at (400,180): no visible marker here any more — the
  // band is the affordance. Not the exact midpoint, which belongs to the
  // connect port's hit circle (paint order makes the port win its ground;
  // the test below claims that spot deliberately).
  dragFromScreenPoint(root, [400, 180], [450, 180])

  const node = latest.canvas.nodes[0]
  if (node === undefined) throw new Error('node missing')
  expect(node.width).toBeGreaterThan(200)
  expect(node.height).toBe(100)
})

it('only the four corner markers are painted — mid-edge chrome is gone', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  selectNode(container)

  const overlay = container.querySelector('[data-testid="selection-overlay"]') as Element
  // Scoped to the selection chrome: the node-tools pill beside the box is a
  // separate control that also paints on the canvas surface.
  const painted = [...overlay.querySelectorAll('rect')].filter(
    (el) =>
      el.getAttribute('fill') === 'var(--background)' &&
      el.closest('[data-testid="node-tools"]') === null,
  )
  expect(painted).toHaveLength(4)
})

it('the exact edge midpoint belongs to the connect port, by design', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const { root } = selectNode(container)
  const r = root.getBoundingClientRect()
  const el = document.elementFromPoint(r.left + 400, r.top + 200)
  expect(el?.getAttribute('data-testid')).toBe('connect-handle')
})

it('the connect port catches a press outside its 10px dot', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const { root, r } = selectNode(container)

  // The dot's centre sits just right of the east edge; press 9px below it —
  // outside the 5px visual radius, inside the 12px hit radius.
  const pressed = pressAt(root, [410, 209])
  expect(pressed.getAttribute('data-testid')).toBe('connect-handle')
  fireEvent.pointerMove(root, { pointerId: 2, clientX: r.left + 500, clientY: r.top + 300 })

  // The connecting gesture's source indicator is the observable that the
  // press actually armed a connect rather than falling through to the canvas.
  expect(container.querySelector('[data-testid="connect-source-indicator"]')).not.toBeNull()
})
