// Moving an END onto a different box, by hand. The verb the element matrix
// found missing from BOTH collections, and the one place the whole way from
// a pointer to the ink can be seen: a reducer test cannot reach the handle,
// and a layout test cannot reach the gesture.
//
// The asymmetry is what the last two cases are for. A stroke's end may land
// in empty space and a relation's may not (ADR-0038 decision 2), so the
// same drag over the same pixels frees one and reverts the other.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const nodes: SpatialCanvas['nodes'] = [
  textNode({ id: 'a', x: 100, y: 100, width: 120, height: 60, text: 'A' }),
  textNode({ id: 'b', x: 400, y: 100, width: 120, height: 60, text: 'B' }),
  textNode({ id: 'c', x: 400, y: 400, width: 120, height: 60, text: 'C' }),
]

const related: SpatialCanvas = {
  nodes,
  edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' } }],
}

const inked: SpatialCanvas = {
  nodes,
  edges: [],
  lines: [{ id: 'l1', from: { kind: 'node', node: 'a' }, to: { kind: 'node', node: 'b' } }],
}

function makeHost(start: SpatialCanvas) {
  const latest: { canvas: SpatialCanvas } = { canvas: start }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
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
  return { Host, latest }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const fire = async (
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  at: { clientX: number; clientY: number },
) => {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 9, button: 0, ...at }))
  await tick()
}

const centre = (element: Element) => {
  const rect = element.getBoundingClientRect()
  return { clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }
}

/** A CLIENT point on the drawn line, taken through the polyline's own geometry. */
function pointOnPath(container: HTMLElement) {
  const polyline = container.querySelector(
    '[data-testid="spatial-editor"] svg polyline',
  ) as SVGPolylineElement
  const at = polyline.getPointAtLength(polyline.getTotalLength() / 2)
  const mapped = at.matrixTransform(polyline.getScreenCTM() as DOMMatrix)
  return { clientX: mapped.x, clientY: mapped.y }
}

/** Root-relative canvas coordinates as a CLIENT point; the viewport is identity at rest. */
function atCanvas(container: HTMLElement, x: number, y: number) {
  const rect = rootOf(container).getBoundingClientRect()
  return { clientX: rect.left + x, clientY: rect.top + y }
}

async function selectThePath(container: HTMLElement) {
  const root = rootOf(container)
  const at = pointOnPath(container)
  await fire(root, 'pointerdown', at)
  await fire(root, 'pointerup', at)
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )
}

async function endHandle(container: HTMLElement, endpoint: 'from' | 'to') {
  return await vi.waitFor(() => {
    const found = container.querySelector(`[data-testid="edge-end-handle-${endpoint}"]`)
    expect(found).not.toBeNull()
    return found as Element
  })
}

/** Press the named end handle, drag to `to`, release there. */
async function dragEnd(
  container: HTMLElement,
  endpoint: 'from' | 'to',
  to: { clientX: number; clientY: number },
) {
  const handle = await endHandle(container, endpoint)
  await fire(handle, 'pointerdown', centre(handle))
  const root = rootOf(container)
  await fire(root, 'pointermove', to)
  await fire(root, 'pointerup', to)
}

it('drags a relation end onto another box', async () => {
  const { Host, latest } = makeHost(related)
  const { container } = render(<Host />)
  await selectThePath(container)

  await dragEnd(container, 'to', atCanvas(container, 460, 430))

  await vi.waitFor(() => expect(latest.canvas.edges[0]?.to).toEqual({ node: 'c' }))
  expect(latest.canvas.edges[0]?.from).toEqual({ node: 'a' })
})

it('leaves a relation end where it was when the drop lands on no box', async () => {
  // A relation cannot end nowhere, so the drag reverts. The stroke case
  // below is the same pixels and the opposite answer.
  const { Host, latest } = makeHost(related)
  const { container } = render(<Host />)
  await selectThePath(container)

  await dragEnd(container, 'to', atCanvas(container, 780, 600))

  await tick()
  expect(latest.canvas.edges[0]?.to).toEqual({ node: 'b' })
})

it('frees a stroke end into empty space, where a relation would have reverted', async () => {
  const { Host, latest } = makeHost(inked)
  const { container } = render(<Host />)
  await selectThePath(container)

  await dragEnd(container, 'to', atCanvas(container, 780, 600))

  await vi.waitFor(() => expect(latest.canvas.lines?.[0]?.to).toMatchObject({ kind: 'point' }))
})

it('outlines the box the pointer is over while the drag runs', async () => {
  // The only feedback the drag gives, and deliberately only the outline:
  // where an end meets a box is the router's, so a preview that drew an
  // attachment point would imply a geometry the commit then contradicts.
  const { Host } = makeHost(related)
  const { container } = render(<Host />)
  await selectThePath(container)

  const handle = await endHandle(container, 'to')
  await fire(handle, 'pointerdown', centre(handle))
  const root = rootOf(container)
  await fire(root, 'pointermove', atCanvas(container, 460, 430))

  await vi.waitFor(() =>
    expect(
      container.querySelector('[data-testid="connect-target-c"][data-hovered="true"]'),
    ).not.toBeNull(),
  )
  expect(
    container.querySelector('[data-testid="connect-target-b"][data-hovered="true"]'),
  ).toBeNull()
})
