// The inspector is not a dialog. It stays open, follows the selection, and
// never takes focus off the canvas — which is what makes reaching a facet
// through it cost one tap after the first, rather than two plus a close.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 40, y: 40, width: 160, height: 90, text: 'A' },
    { id: 'b', type: 'text', x: 300, y: 40, width: 160, height: 90, text: 'B' },
  ],
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

const panelOf = (c: HTMLElement) =>
  c.querySelector('[data-testid="facet-form-panel"]') as HTMLElement | null

const shapeOf = (canvas: SpatialCanvas, id: string) =>
  canvas.nodes.find((n) => n.id === id)?.['x-whiteboard']?.facets?.['visual.shape/v0']

async function openInspector(container: HTMLElement, x: number, y: number) {
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + x, clientY: r.top + y })
  const menu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  fireEvent.click(
    [...menu.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').startsWith('Facets'),
    ) as HTMLElement,
  )
  return root
}

it('stays open across a selection change and edits the newly selected node', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = await openInspector(container, 120, 85)
  expect(panelOf(container)).not.toBeNull()

  // Selecting elsewhere must NOT dismiss it — that is the whole point of a
  // non-modal inspector, and a dialog would have trapped the click.
  await userEvent.click(root, { position: { x: 380, y: 85 } })
  expect(panelOf(container)).not.toBeNull()

  fireEvent.click(panelOf(container)?.querySelector('[aria-label="Diamond"]') as HTMLElement)
  console.log(
    'PROBE a=',
    JSON.stringify(shapeOf(latest.canvas, 'a')),
    'b=',
    JSON.stringify(shapeOf(latest.canvas, 'b')),
  )
  expect(shapeOf(latest.canvas, 'b')).toEqual({ kind: 'diamond' })
  // ...and it edited B, not the node the menu was opened on.
  expect(shapeOf(latest.canvas, 'a')).toBeUndefined()
})

it('leaves focus on the canvas, so typing and shortcuts still reach it', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  await openInspector(container, 120, 85)
  const panel = panelOf(container) as HTMLElement
  expect(panel.contains(document.activeElement)).toBe(false)
})
