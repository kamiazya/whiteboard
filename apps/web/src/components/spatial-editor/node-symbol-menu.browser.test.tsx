// The Symbol band reached the menu with NO core-surface edit — it is a
// facet definition plus a widget registration. This locks the user flow: a
// pick stores visual.symbol/v0 and 'none' removes it without a trace.
//
// It also pins that the pick draws NOTHING on the node. A symbol marks the
// surfaces where a node is too small to read — the canvas overview here,
// covered by minimap.browser.test.tsx — and the node at full size already
// shows its own content.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { VisualSymbolFacet } from '@kamiazya/whiteboard-plugin-visual'
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
  canvas.nodes[0]?.facets?.['visual.symbol/v0'] as VisualSymbolFacet | undefined

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

/** Opens the node menu, then the inspector behind its one facet entry. */
function openInspector(container: HTMLElement): HTMLElement {
  const menu = openNodeMenu(container)
  const entry = [...menu.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').startsWith('Facets'),
  )
  expect(entry).toBeDefined()
  fireEvent.click(entry as HTMLElement)
  const opened = container.querySelector('[data-testid="facet-form-panel"]') as HTMLElement
  expect(opened).not.toBeNull()
  return opened
}

it('an icon pick stores the facet and draws nothing on the node', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  const panel = openInspector(container)
  fireEvent.click(panel.querySelector('[aria-label="Icon star"]') as HTMLElement)

  expect(symbolOf(latest.canvas)).toEqual({ kind: 'icon', name: 'star' })
  // A vendored icon would be a <use> of its symbol; the node draws none.
  const drawn = container.querySelector('[data-testid="spatial-editor"] svg use[href^="#wb-icon-"]')
  expect(drawn).toBeNull()
})

it('an emoji pick is stored rather than drawn, and No symbol removes the facet', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  const glyphText = () =>
    [...container.querySelectorAll('[data-testid="spatial-editor"] svg text')]
      .map((t) => t.textContent)
      .filter((value) => value === '⭐')

  const panel = openInspector(container)
  fireEvent.click(panel.querySelector('[aria-label="Emoji ⭐"]') as HTMLElement)
  expect(symbolOf(latest.canvas)).toEqual({ kind: 'emoji', char: '⭐' })
  // Stored, and not painted on the node.
  expect(glyphText()).toHaveLength(0)

  fireEvent.click(panel.querySelector('[aria-label="No symbol"]') as HTMLElement)
  expect(symbolOf(latest.canvas)).toBeUndefined()
  expect(latest.canvas.nodes[0]).not.toHaveProperty('x-whiteboard')
  expect(glyphText()).toHaveLength(0)
})
