// Canvas-wide display settings (edge routing style, line jumps) live in a
// dedicated settings popover on the dock, not in the empty-space context
// menu — the menu is for actions on the canvas; a growing settings list
// wants its own surface. This pins the wiring: the gear opens the popover,
// a pick emits the canvas-wide command, and the context menu no longer
// carries the rows.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
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

const gearOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="canvas-settings-button"]') as HTMLElement

const settingsMenu = (container: HTMLElement) =>
  container.querySelector('[data-testid="canvas-settings-menu"]')

it('the gear opens the settings popover with both option rows', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)

  expect(settingsMenu(container)).toBeNull()
  fireEvent.click(gearOf(container))

  const menu = settingsMenu(container)
  expect(menu).toBeTruthy()
  expect(menu?.textContent).toContain('Edge routing')
  expect(menu?.textContent).toContain('Line jumps')
})

it('picking a routing style applies it canvas-wide; the popover stays open for the next tweak', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  fireEvent.click(gearOf(container))
  const curved = settingsMenu(container)?.querySelector('[aria-label="Curved"]') as HTMLElement
  expect(curved).toBeTruthy()
  fireEvent.click(curved)

  expect(latest.canvas['x-whiteboard']?.edgeRouting?.style).toBe('curved')
  // Option rows are property pickers: they apply immediately and keep the
  // surface open, same contract as the context menu's rows.
  const menu = settingsMenu(container)
  expect(menu).toBeTruthy()

  fireEvent.keyDown(menu as HTMLElement, { key: 'Escape' })
  expect(settingsMenu(container)).toBeNull()
})

it('toggling line jumps applies canvas-wide', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  fireEvent.click(gearOf(container))
  const on = settingsMenu(container)?.querySelector('[aria-label="On"]') as HTMLElement
  fireEvent.click(on)

  expect(latest.canvas['x-whiteboard']?.edgeRouting?.lineJumps).toBe('arc')
})

it('the popover marks the current values as selected', () => {
  const withCurved: SpatialCanvas = {
    ...initial,
    'x-whiteboard': { edgeRouting: { style: 'curved', lineJumps: 'arc' } },
  }
  function Host() {
    const [canvas, setCanvas] = useState(withCurved)
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
  const { container } = render(<Host />)

  fireEvent.click(gearOf(container))
  const curved = settingsMenu(container)?.querySelector('[aria-label="Curved"]')
  const on = settingsMenu(container)?.querySelector('[aria-label="On"]')
  expect(curved?.getAttribute('aria-checked')).toBe('true')
  expect(on?.getAttribute('aria-checked')).toBe('true')
})

it('Escape hands focus back to the gear, like the add menu does', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)

  const gear = gearOf(container)
  fireEvent.click(gear)
  const menu = settingsMenu(container) as HTMLElement
  expect(menu).toBeTruthy()

  fireEvent.keyDown(menu, { key: 'Escape' })
  expect(settingsMenu(container)).toBeNull()
  // Closing unmounts the focused popover; without an explicit hand-back a
  // keyboard user's focus falls to <body> and they lose their place.
  expect(document.activeElement).toBe(gear)
})

it('the empty-space context menu no longer carries the settings rows', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 700, clientY: r.top + 500 })

  const menu = container.querySelector('[data-testid="context-menu"]')
  expect(menu).toBeTruthy()
  expect(menu?.textContent).not.toContain('Edge routing')
  expect(menu?.textContent).not.toContain('Line jumps')
  // Actions stay: the menu is still where you act on the canvas.
  expect(menu?.textContent).toContain('Tidy canvas')
})
