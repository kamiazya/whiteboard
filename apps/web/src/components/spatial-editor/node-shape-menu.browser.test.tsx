// The node context menu's Shape row: a pick must not just record the
// visual.shape/v0 facet on the node, it must change the silhouette the
// scene DRAWS — and `rect` must remove the facet without a trace.
import type { VisualShapeFacet } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [{ id: 'a', type: 'text', x: 80, y: 80, width: 200, height: 100, text: 'A' }],
  edges: [],
}

const shapeFacetOf = (canvas: SpatialCanvas) =>
  canvas.nodes[0]?.['x-whiteboard']?.facets?.['visual.shape/v0'] as VisualShapeFacet | undefined

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

function openNodeMenu(container: HTMLElement): HTMLElement {
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 180, clientY: r.top + 130 })
  const menu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  expect(menu).not.toBeNull()
  return menu
}

it('the Shape row stores the facet and the scene draws the silhouette', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  const menu = openNodeMenu(container)
  fireEvent.click(menu.querySelector('[aria-label="Hexagon"]') as HTMLElement)

  expect(shapeFacetOf(latest.canvas)).toEqual({ kind: 'hexagon' })
  // The node's chrome is no longer a plain rect: a hexagon draws as a
  // polygon with six points.
  const silhouette = container.querySelector('svg g[data-wb-key] polygon')
  expect(silhouette).not.toBeNull()
  expect(silhouette?.getAttribute('points')?.split(' ')).toHaveLength(6)
})

it('a shape pick from a multi-selection reshapes every selected node', async () => {
  const start: SpatialCanvas = {
    nodes: [
      { id: 'a', type: 'text', x: 80, y: 80, width: 160, height: 90, text: 'A' },
      { id: 'b', type: 'text', x: 320, y: 80, width: 160, height: 90, text: 'B' },
    ],
    edges: [],
  }
  const latest: { canvas: SpatialCanvas } = { canvas: start }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
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
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

  await userEvent.click(root, { position: { x: 160, y: 125 } })
  await userEvent.click(root, { position: { x: 400, y: 125 }, modifiers: ['Shift'] })
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 160, clientY: r.top + 125 })
  const menu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  expect(menu).not.toBeNull()

  fireEvent.click(menu.querySelector('[aria-label="Diamond"]') as HTMLElement)
  await vi.waitFor(() => {
    for (const id of ['a', 'b']) {
      expect(
        latest.canvas.nodes.find((n) => n.id === id)?.['x-whiteboard']?.facets?.['visual.shape/v0'],
      ).toEqual({ kind: 'diamond' })
    }
  })
})

it('Rectangle removes the facet without a trace', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  const first = openNodeMenu(container)
  fireEvent.click(first.querySelector('[aria-label="Cylinder"]') as HTMLElement)
  expect(shapeFacetOf(latest.canvas)).toEqual({ kind: 'cylinder' })

  fireEvent.click(first.querySelector('[aria-label="Rectangle"]') as HTMLElement)
  expect(shapeFacetOf(latest.canvas)).toBeUndefined()
  expect(latest.canvas.nodes[0]).not.toHaveProperty('x-whiteboard')
})
