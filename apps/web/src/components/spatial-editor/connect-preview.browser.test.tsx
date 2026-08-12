// The connect gesture's preview line used to run from the SOURCE NODE'S
// CENTER to the pointer, implying edges attach at the center and diverging
// from the drop result (derived sides + anchor fan-out). The preview now
// routes a tentative edge through the same producer the drop uses, so what
// travels with the pointer IS what lands.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 300, y: 250, width: 160, height: 80, text: 'from' },
    { id: 'b', type: 'text', x: 60, y: 250, width: 120, height: 80, text: 'to-left' },
  ],
  edges: [],
}

function Host() {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="select" canvas={canvas} onChange={setCanvas} theme="light" />
    </div>
  )
}

async function beginConnectFromWest(container: HTMLElement) {
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  await userEvent.click(root, { position: { x: 380, y: 290 } })
  const west = page.getByTestId('connect-handle-w')
  await expect.element(west).toBeInTheDocument()
  const rootRect = root.getBoundingClientRect()
  ;(west.element() as SVGCircleElement).dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      clientX: rootRect.left + 295,
      clientY: rootRect.top + 290,
      pointerId: 80,
      button: 0,
    }),
  )
  return { root, rootRect }
}

const previewPoints = (container: HTMLElement) => {
  const polyline = container.querySelector('[data-testid="drag-preview"] polyline')
  return (polyline?.getAttribute('points') ?? '')
    .split(' ')
    .filter((p) => p.length > 0)
    .map((p) => p.split(',').map(Number) as [number, number])
}

it('previews from the border anchor facing the pointer, not the node center', async () => {
  const { container } = render(<Host />)
  const { root, rootRect } = await beginConnectFromWest(container)

  fireEvent.pointerMove(root, {
    pointerId: 80,
    clientX: rootRect.left + 230,
    clientY: rootRect.top + 290,
    buttons: 1,
  })
  await new Promise((r) => requestAnimationFrame(r))

  const points = previewPoints(container)
  expect(points.length).toBeGreaterThanOrEqual(2)
  // Departure: a's LEFT border anchor (300, 290) — a's center is (380, 290).
  expect(points[0]).toEqual([300, 290])
  // Arrival tracks the pointer exactly.
  expect(points[points.length - 1]).toEqual([230, 290])
})

it('previews the actual routed edge while hovering a target node', async () => {
  const { container } = render(<Host />)
  const { root, rootRect } = await beginConnectFromWest(container)

  // Hover over node b (60..180 x, 250..330 y).
  fireEvent.pointerMove(root, {
    pointerId: 80,
    clientX: rootRect.left + 120,
    clientY: rootRect.top + 290,
    buttons: 1,
  })
  await new Promise((r) => requestAnimationFrame(r))

  const points = previewPoints(container)
  // The exact drop-result route: a's left anchor to b's right anchor.
  expect(points[0]).toEqual([300, 290])
  expect(points[points.length - 1]).toEqual([180, 290])
})

it('the preview line carries the committed arrowhead', async () => {
  const { container } = render(<Host />)
  const { root, rootRect } = await beginConnectFromWest(container)

  fireEvent.pointerMove(root, {
    pointerId: 80,
    clientX: rootRect.left + 230,
    clientY: rootRect.top + 290,
    buttons: 1,
  })
  await new Promise((r) => requestAnimationFrame(r))

  const arrow = container.querySelector('[data-testid="drag-preview"] polygon')
  expect(arrow).not.toBeNull()
  const corners = (arrow?.getAttribute('points') ?? '').split(' ').filter((p) => p.length > 0)
  expect(corners.length).toBe(3)
})
