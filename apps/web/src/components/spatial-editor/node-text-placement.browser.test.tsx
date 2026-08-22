// visual.text/v0 reached the menu with NO apps/web change at all: it is a
// facet definition carrying an editor spec, rendered by the tier-2 path.
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

it('the Text row stores the facet and moves the drawn text', () => {
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
  const textY = () =>
    Number(
      (
        container.querySelector('[data-testid="spatial-editor"] svg text') as SVGTextElement | null
      )?.getAttribute('y') ?? '0',
    )
  const before = textY()

  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 180, clientY: r.top + 130 })
  const menu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  fireEvent.click(menu.querySelector('[aria-label="Middle"]') as HTMLElement)

  expect(latest.canvas.nodes[0]?.['x-whiteboard']?.facets?.['visual.text/v0']).toEqual({
    align: 'center',
  })
  // Not merely stored: a rect's text moved down from the top.
  expect(textY()).toBeGreaterThan(before)
})
