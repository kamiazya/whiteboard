// The tier-1 editor, end to end in a real browser: the menu's Facets…
// entry opens the panel, an edit stores the facet on the node, and the
// scene reflects it — the path an agent-written facet with no quick band
// would otherwise be invisible on.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [{ id: 'a', type: 'text', x: 80, y: 80, width: 200, height: 100, text: 'A' }],
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
  // The dialog takes focus, so Escape reaches its handler rather than the
  // canvas behind it.
  expect(panel.contains(document.activeElement)).toBe(true)

  // visual.shape's derived form: a choice control over the five silhouettes.
  const select = panel.querySelector(
    'select[aria-label="Visual style shape kind"]',
  ) as HTMLSelectElement
  fireEvent.change(select, { target: { value: 'hexagon' } })
  const save = [...panel.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith('Save Visual style shape'),
  ) as HTMLElement
  fireEvent.click(save)

  expect(latest.canvas.nodes[0]?.['x-whiteboard']?.facets?.['visual.shape/v0']).toEqual({
    kind: 'hexagon',
  })
  expect(container.querySelector('svg g[data-wb-key] polygon')).not.toBeNull()

  fireEvent.keyDown(panel, { key: 'Escape' })
  expect(container.querySelector('[data-testid="facet-form-panel"]')).toBeNull()
})
