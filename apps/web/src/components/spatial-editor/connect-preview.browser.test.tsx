// The connect gesture's preview line used to run from the SOURCE NODE'S
// CENTER to the pointer, implying edges attach at the center and diverging
// from the drop result (derived sides + anchor fan-out). The preview now
// routes a tentative edge through the same producer the drop uses, so what
// travels with the pointer IS what lands.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 300, y: 250, width: 160, height: 80, text: 'from' }),
    textNode({ id: 'b', x: 60, y: 250, width: 120, height: 80, text: 'to-left' }),
  ],
  edges: [],
}

const { Host } = makeEditorHost({ initial: start })

/** A note above a frame, and a member of it straight below the note. */
const framed: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 300, y: 250, width: 160, height: 80, text: 'above' }),
    groupNode({
      id: 'frame',
      x: 260,
      y: 410,
      width: 400,
      height: 180,
      label: 'Next actions agreed with the team',
    }),
    textNode({ id: 'member', x: 300, y: 470, width: 160, height: 80, text: 'member' }),
  ],
  edges: [],
}

const { Host: FramedHost } = makeEditorHost({ initial: framed })

async function beginConnectFromWest(container: HTMLElement) {
  const root = rootOf(container)
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

it('previews a route round a frame title, as the drop routes it', async () => {
  const { container } = render(<FramedHost />)
  const { root, rootRect } = await beginConnectFromWest(container)

  // Hover the member: the straight drop to it runs through the title.
  fireEvent.pointerMove(root, {
    pointerId: 80,
    clientX: rootRect.left + 380,
    clientY: rootRect.top + 510,
    buttons: 1,
  })
  await new Promise((r) => requestAnimationFrame(r))

  // A straight drop is two points; the committed route steps round.
  const points = previewPoints(container)
  expect(points.length).toBeGreaterThan(2)
})
