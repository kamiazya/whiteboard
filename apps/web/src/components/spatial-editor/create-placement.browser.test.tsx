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

  // The menu survives the drag and closes on dragend. Closing it any earlier
  // removes the dragged element mid-drag, which tears the drag session down
  // in Chromium and means no drop ever arrives.
  expect(container.querySelector('[data-testid="add-menu"]')).not.toBeNull()
  fireEvent(entry, dragEvent('dragend'))
  expect(container.querySelector('[data-testid="add-menu"]')).toBeNull()
})

it('two rectangles from the menu do not stack on the same spot', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  for (let i = 0; i < 2; i++) {
    openAddMenu(container)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add rectangle' }))
  }

  const [first, second] = latest.canvas.nodes
  if (first === undefined || second === undefined) throw new Error('expected two nodes')
  // The tap path always resolves to the same viewport-centre point, so
  // without a free-spot cascade the second one lands exactly on the first
  // and is indistinguishable from having created nothing.
  expect({ x: second.x, y: second.y }).not.toEqual({ x: first.x, y: first.y })
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

it('creating repeatedly does not move the viewport while the screen has room', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const transform = () =>
    (container.querySelector('[data-testid="viewport-transform"]') as HTMLElement).style.transform
  const before = transform()

  // Four is well within what an 800x600 view holds at 200x100 per node —
  // enough to prove the point without making this the suite's heaviest file.
  for (let i = 0; i < 4; i++) {
    openAddMenu(container)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add rectangle' }))
  }

  // Making something is not a request to go somewhere: the canvas under the
  // hand must stay put while there is still room in view to place into.
  expect(transform()).toBe(before)
})

it('nothing is ever parked under the dock', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const dock = container.querySelector('[data-testid="tool-palette"]') as HTMLElement

  for (let i = 0; i < 5; i++) {
    openAddMenu(container)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add rectangle' }))
  }

  const rootRect = root.getBoundingClientRect()
  const dockTop = dock.getBoundingClientRect().top - rootRect.top
  const zoom = Number(/scale\(([\d.]+)\)/.exec(transformOfRoot(container))?.[1] ?? 1)
  const offset = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(transformOfRoot(container))
  const panY = Number(offset?.[2] ?? 0)
  for (const node of latest.canvas.nodes) {
    const screenBottom = (node.y + node.height) * zoom + panY
    const screenTop = node.y * zoom + panY
    // A node whose whole body is above the dock strip, or scrolled off the
    // top, is fine — the failure being pinned is a node sitting IN the strip.
    if (screenTop > rootRect.height) continue
    expect(screenBottom).toBeLessThanOrEqual(dockTop)
  }
})

function transformOfRoot(container: HTMLElement): string {
  return (container.querySelector('[data-testid="viewport-transform"]') as HTMLElement).style
    .transform
}
