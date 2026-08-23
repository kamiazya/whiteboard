// The panel is centred, so a box wider than the editor spills off BOTH
// edges — and the controls nearest each edge become untappable. Only a real
// browser has the layout to measure that.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [{ id: 'a', type: 'text', x: 60, y: 60, width: 140, height: 80, text: 'A' }],
  edges: [],
}

it('the facets panel stays inside a phone-width editor', () => {
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    return (
      <div style={{ width: 390, height: 700 }}>
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
  fireEvent.contextMenu(root, { clientX: r.left + 120, clientY: r.top + 100 })
  fireEvent.click(
    [...container.querySelectorAll('[data-testid="context-menu"] button')].find((b) =>
      (b.textContent ?? '').startsWith('Facets'),
    ) as HTMLElement,
  )

  const panel = container.querySelector('[data-testid="facet-form-panel"]') as HTMLElement
  const box = panel.getBoundingClientRect()
  // Uncapped this measured -192..582 against an editor of 0..390.
  expect(`${Math.round(box.left)}..${Math.round(box.right)}`).toBe(
    `${Math.max(Math.round(box.left), Math.round(r.left))}..${Math.min(Math.round(box.right), Math.round(r.right))}`,
  )
  // A collapsed panel would also "fit".
  expect(box.width).toBeGreaterThan(100)
  // And nothing INSIDE may stick out either — a capped box still clips a
  // segmented row that refuses to wrap.
  const escapees = [...panel.querySelectorAll('input,select,button')]
    .map((el) => ({ name: el.getAttribute('aria-label') ?? '?', b: el.getBoundingClientRect() }))
    .filter(({ b }) => b.right > box.right + 0.5 || b.left < box.left - 0.5)
    .map(({ name, b }) => `${name} @${Math.round(b.left)}..${Math.round(b.right)}`)
  expect(escapees).toEqual([])
})
