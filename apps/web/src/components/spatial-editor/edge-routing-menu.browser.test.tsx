// Provisional UI for the canvas-wide routing style.
//
// It lives on empty space because empty space IS the canvas, and the recorded
// OOUI rule puts actions on an existing object with that object — the dock's
// "+" menu stays for things that do not exist yet. Placement is provisional;
// the rule it follows is not.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 40, y: 40, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 400, y: 240, width: 120, height: 60, text: 'B' },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
}

function makeHost() {
  const latest = { canvas: initial }
  function Host() {
    const [canvas, setCanvas] = useState(initial)
    latest.canvas = canvas
    return (
      <div style={{ width: 900, height: 700 }}>
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

const rootOf = (c: HTMLElement) => c.querySelector('[data-testid="spatial-editor"]') as HTMLElement

function openCanvasMenu(root: HTMLElement) {
  const r = root.getBoundingClientRect()
  root.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + 700,
      clientY: r.top + 560,
      button: 2,
    }),
  )
}

const optionButton = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('[data-testid="context-menu"] button')].find(
    (button) => button.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined

it('offers the routing style from the canvas itself, not the creation menu', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  openCanvasMenu(rootOf(container))

  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="context-menu"]')).not.toBeNull()
  })
  expect(container.textContent).toContain('Edge routing')
  expect(optionButton(container, 'Orthogonal')).toBeDefined()

  // The dock's "+" menu is for what does not exist yet; a canvas-wide setting
  // must not appear there.
  const addButton = container.querySelector('[data-testid="add-button"]') as HTMLButtonElement
  addButton.click()
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="add-menu"]')).not.toBeNull()
  })
  expect(container.querySelector('[data-testid="add-menu"]')?.textContent).not.toContain('routing')
})

it('records the choice on the canvas and bends the edge', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  openCanvasMenu(rootOf(container))

  await vi.waitFor(() => expect(optionButton(container, 'Orthogonal')).toBeDefined())
  optionButton(container, 'Orthogonal')?.click()

  await vi.waitFor(() => {
    expect(latest.canvas['x-whiteboard']?.edgeRouting?.style).toBe('orthogonal')
  })
  // The scene follows: a bent edge has more than the two endpoint points.
  await vi.waitFor(() => {
    const polyline = container.querySelector('polyline')
    expect(polyline?.getAttribute('points')?.split(' ').length).toBeGreaterThan(2)
  })
})

// Straight is the default, so choosing it must leave no trace — otherwise
// every canvas anyone opened the menu on carries a redundant extension.
it('drops the setting again when the style returns to straight', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  openCanvasMenu(rootOf(container))
  await vi.waitFor(() => expect(optionButton(container, 'Orthogonal')).toBeDefined())
  optionButton(container, 'Orthogonal')?.click()
  await vi.waitFor(() =>
    expect(latest.canvas['x-whiteboard']?.edgeRouting?.style).toBe('orthogonal'),
  )

  openCanvasMenu(rootOf(container))
  await vi.waitFor(() => expect(optionButton(container, 'Straight')).toBeDefined())
  optionButton(container, 'Straight')?.click()

  await vi.waitFor(() => {
    expect(latest.canvas).not.toHaveProperty('x-whiteboard')
  })
})
