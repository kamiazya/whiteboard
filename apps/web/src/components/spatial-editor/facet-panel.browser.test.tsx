// The tier-1 editor, end to end in a real browser: the menu's Facets…
// entry opens the panel, an edit stores the facet on the node, and the
// scene reflects it — the path an agent-written facet with no quick band
// would otherwise be invisible on.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 80, y: 80, width: 200, height: 100, text: 'A' })],
  edges: [],
}

it('the Facets entry opens the panel, and a pick there stores and draws', () => {
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
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 180, clientY: r.top + 130 })
  const menu = container.querySelector('[data-testid="context-menu"]') as HTMLElement

  const entry = [...menu.querySelectorAll('button')].find((b) => b.textContent?.includes('Facets'))
  expect(entry).toBeDefined()
  fireEvent.click(entry as HTMLElement)

  const panel = container.querySelector('[data-testid="facet-form-panel"]') as HTMLElement
  expect(panel).not.toBeNull()
  // NOT a dialog: it leaves focus on the canvas, so typing and shortcuts
  // keep working while it is open.
  expect(panel.contains(document.activeElement)).toBe(false)

  // visual.shape DECLARES its editor, so the panel shows the segmented
  // control the spec names — including Rectangle, which is the facet's
  // ABSENCE rather than a stored value.
  const hexagon = panel.querySelector('input[aria-label="Hexagon"]') as HTMLInputElement
  expect(hexagon).not.toBeNull()
  // A CHOICE applies on pick, the way the same facet's quick band does —
  // there is no Save to press, and a facet made only of choices has none.
  fireEvent.click(hexagon)
  // ONE Save, and it is the classification's: every visual facet applies on
  // pick or through its registered picker, and `semantic.class/v0` (ADR-0036
  // §6) is two free-entry identifiers, the first bundled facet that stages
  // until Save. Listed by name so a facet that grows a Save it should not
  // have is caught here, not in a jsdom fixture.
  expect(
    [...panel.querySelectorAll('button[aria-label^="Save"]')].map((b) =>
      b.getAttribute('aria-label'),
    ),
  ).toEqual(['Save Classification'])
  // The picker that used to be a context-menu band is here instead, as a
  // TRIGGER: a catalog is hundreds of cells and a property row is one line,
  // so the row shows what is chosen and the choosing happens over the top.
  expect(panel.querySelector('[aria-label="Choose symbol"]')).not.toBeNull()
  // Nothing of it is mounted until then — which is what keeps the
  // catalog's chunk unfetched for a panel nobody opened.
  expect(panel.querySelector('[aria-label="Search symbols"]')).toBeNull()
  // And there is only ever ONE box inside it: free entry is a result of the
  // search, not a field beside it.
  expect(panel.querySelector('[aria-label="Any character or emoji"]')).toBeNull()

  expect(latest.canvas.nodes[0]?.facets?.['visual.shape/v0']).toEqual({
    kind: 'hexagon',
  })
  expect(container.querySelector('svg g[data-wb-key] polygon')).not.toBeNull()

  // A person's write path for a box's SECOND axis: what it is stays in the
  // silhouette, how it is doing goes in the classification, and both land
  // on the same node — the board the facet score reads as
  // `carried(semantic.class/v0)` with nothing declared.
  fireEvent.change(panel.querySelector('input[aria-label="Classification Axis"]') as HTMLElement, {
    target: { value: 'health' },
  })
  fireEvent.change(panel.querySelector('input[aria-label="Classification Value"]') as HTMLElement, {
    target: { value: 'failing' },
  })
  fireEvent.click(panel.querySelector('button[aria-label="Save Classification"]') as HTMLElement)
  expect(latest.canvas.nodes[0]?.facets).toEqual({
    'visual.shape/v0': { kind: 'hexagon' },
    'semantic.class/v0': { axis: 'health', value: 'failing' },
  })

  // DESELECTING is the way out, and the only one: the panel carries no
  // dismiss control of its own, because it is about the selected node and a
  // press on blank canvas is already how a surface is put away here.
  expect(
    panel.querySelector('[aria-label="Close facets"]'),
    'the panel grew a dismiss control again — two ways to put one surface away',
  ).toBeNull()
  fireEvent.pointerDown(root, { clientX: 20, clientY: 400, button: 0, pointerId: 7 })
  fireEvent.pointerUp(root, { clientX: 20, clientY: 400, button: 0, pointerId: 7 })
  expect(container.querySelector('[data-testid="facet-form-panel"]')).toBeNull()
})
