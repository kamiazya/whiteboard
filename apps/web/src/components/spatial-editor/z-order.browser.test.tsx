// Z-order manipulation: [ / ] / Shift+[ / Shift+] via the shortcut catalog
// (shortcuts.ts), and the context menu's Order row as the touch path.
// Array order IS z-order — assertions read the canvas node order directly.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// An overlapping chain (a∩b, b∩c, a∦c): forward/backward are
// overlap-aware, so the fixture must actually overlap for them to move.
const initial: SpatialCanvas = {
  nodes: (['a', 'b', 'c'] as const).map((id, index) => ({
    id,
    type: 'text',
    x: index * 150,
    y: 100,
    width: 200,
    height: 80,
    text: id,
  })),
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

function selectNodeB(container: HTMLElement): HTMLElement {
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()
  // x 250 lands on b ONLY (a ends at 200, c starts at 300).
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 250,
    clientY: r.top + 140,
  })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 250, clientY: r.top + 140 })
  expect(container.querySelector('[data-testid="selection-overlay"]')).not.toBeNull()
  return root
}

const orderOf = (canvas: SpatialCanvas) => canvas.nodes.map((node) => node.id)

it('bracket shortcuts reorder the selected node through all four placements', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = selectNodeB(container)

  fireEvent.keyDown(root, { code: 'BracketRight', key: ']' })
  expect(orderOf(latest.canvas)).toEqual(['a', 'c', 'b'])

  fireEvent.keyDown(root, { code: 'BracketLeft', key: '[' })
  expect(orderOf(latest.canvas)).toEqual(['a', 'b', 'c'])

  fireEvent.keyDown(root, { code: 'BracketRight', key: '}', shiftKey: true })
  expect(orderOf(latest.canvas)).toEqual(['a', 'c', 'b'])

  fireEvent.keyDown(root, { code: 'BracketLeft', key: '{', shiftKey: true })
  expect(orderOf(latest.canvas)).toEqual(['b', 'a', 'c'])

  // Extremes are total no-ops (already at back).
  fireEvent.keyDown(root, { code: 'BracketLeft', key: '[' })
  expect(orderOf(latest.canvas)).toEqual(['b', 'a', 'c'])
})

it('never fires from a text-entry surface or with a browser modifier held', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = selectNodeB(container)

  fireEvent.keyDown(root, { code: 'BracketRight', key: ']', metaKey: true })
  expect(orderOf(latest.canvas)).toEqual(['a', 'b', 'c'])

  // Typing a bracket inside the node text editor must not reorder.
  fireEvent.pointerDown(root, { button: 0, pointerId: 2, clientX: 320, clientY: 140 })
  fireEvent.pointerUp(root, { pointerId: 2, clientX: 320, clientY: 140 })
  fireEvent.pointerDown(root, { button: 0, pointerId: 3, clientX: 320, clientY: 140 })
  fireEvent.pointerUp(root, { pointerId: 3, clientX: 320, clientY: 140 })
  const textarea = container.querySelector('textarea')
  if (textarea !== null) {
    fireEvent.keyDown(textarea, { code: 'BracketRight', key: ']' })
    expect(orderOf(latest.canvas)).toEqual(['a', 'b', 'c'])
  }
})

it("the node context menu's Order row applies each placement in one tap", () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()

  fireEvent.contextMenu(root, { clientX: r.left + 250, clientY: r.top + 140 })
  const menu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  expect(menu).not.toBeNull()
  fireEvent.click(menu.querySelector('[aria-label="Bring to front"]') as HTMLElement)
  expect(orderOf(latest.canvas)).toEqual(['a', 'c', 'b'])

  fireEvent.contextMenu(root, { clientX: r.left + 250, clientY: r.top + 140 })
  const menu2 = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  fireEvent.click(menu2.querySelector('[aria-label="Send to back"]') as HTMLElement)
  expect(orderOf(latest.canvas)).toEqual(['b', 'a', 'c'])
})

it('a multi-selection reorders as one block', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = selectNodeB(container)
  const r = root.getBoundingClientRect()
  // Shift-click node a to build {b, a}.
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 4,
    shiftKey: true,
    clientX: r.left + 100,
    clientY: r.top + 140,
  })
  fireEvent.pointerUp(root, {
    pointerId: 4,
    shiftKey: true,
    clientX: r.left + 100,
    clientY: r.top + 140,
  })

  fireEvent.keyDown(root, { code: 'BracketRight', key: '}', shiftKey: true })
  expect(orderOf(latest.canvas)).toEqual(['c', 'a', 'b'])
})
