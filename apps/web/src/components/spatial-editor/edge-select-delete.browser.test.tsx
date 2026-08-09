// Create/delete symmetry for edges: the Connect tool makes edge creation a
// two-click flow, so a misclicked connection must be just as removable —
// click the edge line to select it, press Delete to remove it.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

function makeStart(): SpatialCanvas {
  return {
    nodes: [
      { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'A' },
      { id: 'b', type: 'text', x: 400, y: 100, width: 120, height: 60, text: 'B' },
    ],
    edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
  }
}

function makeHost() {
  const start = makeStart()
  const latest: { canvas: SpatialCanvas; commands: string[] } = { canvas: start, commands: [] }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next, command) => {
            latest.commands.push(command.kind)
            setCanvas(next)
          }}
          theme="light"
        />
      </div>
    )
  }
  return { Host, latest }
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

/**
 * Element-relative click position ON the rendered edge, derived from the
 * committed polyline's own client rect. Hardcoded canvas coordinates break
 * under the vitest browser iframe's UI scaling (the page renders scaled, so
 * a fixed element-relative point lands elsewhere in canvas space depending
 * on the current scale); rect-derived positions live in the same scaled
 * space as the click and stay correct at any zoom.
 */
function edgeMidpointPosition(container: HTMLElement): { x: number; y: number } {
  const root = rootOf(container)
  const polyline = container.querySelector(
    '[data-testid="spatial-editor"] svg polyline',
  ) as SVGPolylineElement
  const edgeRect = polyline.getBoundingClientRect()
  const rootRect = root.getBoundingClientRect()
  return {
    x: edgeRect.x + edgeRect.width / 2 - rootRect.x,
    y: edgeRect.y + edgeRect.height / 2 - rootRect.y,
  }
}

it('clicking an edge selects it and Delete removes it', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  await userEvent.click(rootOf(container), { position: edgeMidpointPosition(container) })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )

  rootOf(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
  await vi.waitFor(() => expect(latest.canvas.edges).toHaveLength(0))
  expect(latest.commands).toContain('delete-edge')
  // Nodes are untouched.
  expect(latest.canvas.nodes).toHaveLength(2)
})

it('a real keyboard Delete works after a cold edge click (focus lands in the editor)', async () => {
  // Live-verification regression: dispatching a synthetic keydown on the
  // editor root bypasses focus, but a real key press goes to
  // document.activeElement. A cold click on an edge hits no focusable
  // element (unlike node shapes, which carry tabIndex), so unless the
  // editor takes focus on edge selection, the real Delete lands on <body>
  // and nothing happens. userEvent.keyboard routes through activeElement,
  // pinning the real path.
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  await userEvent.click(rootOf(container), { position: edgeMidpointPosition(container) })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )

  await userEvent.keyboard('{Delete}')
  await vi.waitFor(() => expect(latest.canvas.edges).toHaveLength(0))
})

it('a click NEAR but not on the edge selects nothing', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  const mid = edgeMidpointPosition(container)
  await userEvent.click(rootOf(container), { position: { x: mid.x, y: mid.y + 50 } })
  expect(container.querySelector('[data-testid="edge-selection-highlight"]')).toBeNull()

  rootOf(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
  expect(latest.canvas.edges).toHaveLength(1)
})

it('Escape and empty-space clicks clear the edge selection without deleting', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  await userEvent.click(rootOf(container), { position: edgeMidpointPosition(container) })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )
  rootOf(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).toBeNull(),
  )
  expect(latest.canvas.edges).toHaveLength(1)

  // The pointer path of the same policy: reselect, then click empty space.
  await userEvent.click(rootOf(container), { position: edgeMidpointPosition(container) })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )
  await userEvent.click(rootOf(container), { position: { x: 650, y: 300 } })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).toBeNull(),
  )
  expect(latest.canvas.edges).toHaveLength(1)
})

it('Shift-clicking a node clears the edge selection (mutually exclusive)', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  await userEvent.click(rootOf(container), { position: edgeMidpointPosition(container) })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )

  await userEvent.click(rootOf(container), { position: { x: 160, y: 130 }, modifiers: ['Shift'] })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).toBeNull(),
  )
  // Delete now acts on the node selection, never the previously clicked edge.
  rootOf(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
  await vi.waitFor(() => expect(latest.canvas.nodes.length).toBeLessThan(2))
  expect(latest.commands).not.toContain('delete-edge')
})

it('a marquee drag that starts on an edge line ends with no edge selected', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  const mid = edgeMidpointPosition(container)
  // Drag from the edge line into empty space below: this is a marquee, not
  // an edge click, so the press-time edge selection must not survive it.
  await userEvent.dragAndDrop(rootOf(container), rootOf(container), {
    sourcePosition: mid,
    targetPosition: { x: mid.x + 120, y: mid.y + 150 },
  })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).toBeNull(),
  )
  rootOf(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
  expect(latest.canvas.edges).toHaveLength(1)
  expect(latest.commands).not.toContain('delete-edge')
})
