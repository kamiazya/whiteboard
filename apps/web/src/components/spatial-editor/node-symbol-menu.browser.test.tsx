// The Symbol band reached the menu with NO core-surface edit — it is a
// facet definition plus a widget registration. This locks the user flow:
// a pick stores visual.symbol/v0 and the scene draws the badge; 'none'
// removes it without a trace.
import type { VisualSymbolFacet } from '@kamiazya/whiteboard-facet-engine'
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

const symbolOf = (canvas: SpatialCanvas) =>
  canvas.nodes[0]?.['x-whiteboard']?.facets?.['visual.symbol/v0'] as VisualSymbolFacet | undefined

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
  return container.querySelector('[data-testid="context-menu"]') as HTMLElement
}

it('an icon pick stores the facet and the scene draws the badge', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  const menu = openNodeMenu(container)
  fireEvent.click(menu.querySelector('[aria-label="Icon star"]') as HTMLElement)

  expect(symbolOf(latest.canvas)).toEqual({ kind: 'icon', name: 'star' })
  // The badge is a <use> of the vendored icon symbol, drawn in the scene.
  const badge = container.querySelector('[data-testid="spatial-editor"] svg use[href^="#wb-icon-"]')
  expect(badge).not.toBeNull()
})

it('an emoji pick draws a glyph, and No symbol removes the facet', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  const menu = openNodeMenu(container)
  fireEvent.click(menu.querySelector('[aria-label="Emoji ⭐"]') as HTMLElement)
  expect(symbolOf(latest.canvas)).toEqual({ kind: 'emoji', char: '⭐' })

  fireEvent.click(menu.querySelector('[aria-label="No symbol"]') as HTMLElement)
  expect(symbolOf(latest.canvas)).toBeUndefined()
  expect(latest.canvas.nodes[0]).not.toHaveProperty('x-whiteboard')
})
