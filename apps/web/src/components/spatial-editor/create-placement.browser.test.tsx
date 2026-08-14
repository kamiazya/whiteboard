// Where a created node LANDS, and which creations open an editor.
//
// Two paths out of the "+" menu, deliberately different: tapping an entry
// keeps its long-standing behaviour (viewport centre), while dragging one
// onto the canvas places it where it is dropped — the viewport never moves,
// so nothing has to pan to show what was just made.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const empty: SpatialCanvas = { nodes: [], edges: [] }

function makeHost() {
  const latest: { canvas: SpatialCanvas } = { canvas: empty }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(empty)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor canvas={canvas} onChange={(next) => setCanvas(next)} theme="light" />
      </div>
    )
  }
  return { Host, latest }
}

function openAddMenu(container: HTMLElement) {
  fireEvent.click(container.querySelector('[data-testid="add-button"]') as HTMLElement)
}

/** The canvas-space centre of the one node on the canvas. */
function soleNodeCentre(canvas: SpatialCanvas) {
  const node = canvas.nodes[0]
  if (node === undefined) throw new Error('no node was created')
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 }
}

it('Add rectangle creates an empty node and leaves the editor closed', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  openAddMenu(container)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add rectangle' }))

  expect(latest.canvas.nodes).toHaveLength(1)
  const node = latest.canvas.nodes[0]
  // A rectangle is not a new node type — JSON Canvas has none, and the
  // x-whiteboard extension is deliberately not an escape hatch for new
  // visual primitives. It is a text node nobody typed into.
  expect(node?.type).toBe('text')
  expect(node?.type === 'text' ? node.text : 'unset').toBe('')
  // The one behavioural difference from Add note: no editor opens.
  expect(container.querySelector('[data-testid="text-node-editor"]')).toBeNull()
})

it('Add note still opens its editor — the rectangle path did not change it', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)

  openAddMenu(container)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add note' }))

  expect(container.querySelector('[data-testid="text-node-editor"]')).not.toBeNull()
})

it('dragging a menu entry onto the canvas creates it AT THE DROP POINT, not the centre', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()

  openAddMenu(container)
  const entry = screen.getByRole('menuitem', { name: 'Add rectangle' })
  // Real DragEvents, not fireEvent's synthesised ones: `dataTransfer` is
  // read-only on a DragEvent, so an assigned property never reaches the
  // handler and the drag silently carries nothing.
  const dataTransfer = new DataTransfer()
  const dragEvent = (type: string, init: DragEventInit = {}) =>
    new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ...init })

  // Dispatched THROUGH fireEvent, which wraps in act(): a raw dispatchEvent
  // leaves React's state update unflushed and the assertion reads the canvas
  // as it was before the drop.
  fireEvent(entry, dragEvent('dragstart'))
  // The kind rides in the MIME type — `types` survives protected mode, the
  // data does not (see CREATE_DRAG_MIME_PREFIX).
  expect([...dataTransfer.types]).toContain('application/x-whiteboard-create+rectangle')

  // Well away from the viewport centre (400,300 in root-local pixels).
  const drop: [number, number] = [640, 120]
  const at = { clientX: r.left + drop[0], clientY: r.top + drop[1] }
  const over = dragEvent('dragover', at)
  fireEvent(root, over)
  // The canvas must accept the drag, or the browser shows a no-drop cursor
  // and never delivers a drop at all.
  expect(over.defaultPrevented).toBe(true)
  fireEvent(root, dragEvent('drop', at))

  // Zoom is 1 and the viewport starts at the origin, so root-local pixels
  // are canvas units here.
  const centre = soleNodeCentre(latest.canvas)
  expect(centre.x).toBeCloseTo(drop[0], 0)
  expect(centre.y).toBeCloseTo(drop[1], 0)
})

it('tapping a menu entry keeps placing it at the viewport centre', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  openAddMenu(container)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Add rectangle' }))

  const centre = soleNodeCentre(latest.canvas)
  expect(centre.x).toBeCloseTo(400, 0)
  expect(centre.y).toBeCloseTo(300, 0)
})
