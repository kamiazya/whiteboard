// One edge's own routing, end to end in a real browser: right-click the
// edge, open the inspector behind its Facets entry, choose a routing, and
// the scene must DRAW that edge differently while its neighbour keeps the
// board's. Storing the facet is not the claim — the drawn path is.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { VisualEdgesFacet } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// Two diagonal pairs, so both edges have the same shape and only the facet
// can separate them.
const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 60, y: 60, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 400, y: 260, width: 120, height: 60, text: 'B' },
    { id: 'c', type: 'text', x: 60, y: 420, width: 120, height: 60, text: 'C' },
  ],
  edges: [
    { id: 'ab', fromNode: 'a', toNode: 'b' },
    { id: 'cb', fromNode: 'c', toNode: 'b' },
  ],
}

const edgeFacetOf = (canvas: SpatialCanvas, id: string) =>
  canvas.edges.find((edge) => edge.id === id)?.['x-whiteboard']?.facets?.['visual.edges/v0'] as
    | VisualEdgesFacet
    | undefined

/**
 * How many points the scene DREW for each edge, ascending. The serializer
 * puts no id on an edge (it emits a presentational `polyline`), so the count
 * is what separates a bent edge from a straight one — which is exactly the
 * claim, and needs no handle.
 */
function drawnPointCounts(container: HTMLElement): number[] {
  // A routed edge is the only `polyline` the editor draws: node chrome is a
  // rect or a shape path, and every toolbar icon is a path too. So the
  // element type is the handle the serializer's id-less output does not give.
  const edges = [...container.querySelectorAll('polyline')]
    .map((el) => (el.getAttribute('points') ?? '').trim().split(/\s+/).length)
    .filter((count) => count >= 2)
  return edges.sort((a, b) => a - b)
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

it('an edge inspector write routes that edge, and its neighbour keeps the board default', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

  // Both edges start straight: two points each, the board's default.
  expect(drawnPointCounts(container)).toEqual([2, 2])

  // The DRAWN a->b line's own middle, in screen coordinates. Taken from the
  // element rather than computed from the node centres: the anchor pass may
  // re-side an end, and a press aimed at the geometric midpoint would then
  // land on blank canvas and open the canvas menu instead. Edges are emitted
  // in document order, so index 0 is `ab`.
  const drawn = [...container.querySelectorAll('polyline')][0] as SVGPolylineElement
  expect(drawn).toBeDefined()
  const box = drawn.getBoundingClientRect()
  fireEvent.contextMenu(root, {
    clientX: box.left + box.width / 2,
    clientY: box.top + box.height / 2,
  })

  const menu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  expect(menu).not.toBeNull()
  const entry = [...menu.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').startsWith('Facets'),
  )
  // The doorway is only offered when the menu opened on the EDGE; if it is
  // missing the press landed on blank canvas and the rest would test nothing.
  expect(
    entry,
    `edge menu items: ${[...menu.querySelectorAll('button')].map((b) => b.textContent)}`,
  ).toBeDefined()
  fireEvent.click(entry as HTMLElement)

  const panel = container.querySelector('[data-testid="facet-form-panel"]') as HTMLElement
  expect(panel).not.toBeNull()
  // The row `visual.edges/v0` DECLARES — a card per routing, glyph over
  // word, the same control the board's own Display panel draws. It was a
  // derived `<select>` until the facet declared an editor, and the picture
  // is the point: this is the one surface where a person compares routings.
  // A pick applies on change, as the board's row does; the derived form
  // keeps Save only for the fields you type into.
  const routing = panel.querySelector(
    'input[type="radio"][aria-label="Orthogonal"]',
  ) as HTMLInputElement
  expect(
    routing,
    `edge panel controls: ${[...panel.querySelectorAll('input,select')].map((el) => el.getAttribute('aria-label'))}`,
  ).not.toBeNull()
  fireEvent.click(routing)

  expect(edgeFacetOf(latest.canvas, 'ab')).toEqual({ routing: 'orthogonal' })
  expect(edgeFacetOf(latest.canvas, 'cb')).toBeUndefined()
  // One edge bent, the other did not — the whole claim of a per-edge answer.
  const [straight, bent] = drawnPointCounts(container)
  expect(straight).toBe(2)
  expect(bent).toBeGreaterThan(2)
})
