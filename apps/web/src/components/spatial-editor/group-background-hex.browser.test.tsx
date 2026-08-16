// JSON Canvas parity for the two authoring gaps the spec audit found:
// a custom HEX color can only round-trip, not be SET here, and a group's
// background image had no setting UI at all. Real pointer input throughout.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [
    { id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' },
    { id: 'g1', type: 'group', x: 400, y: 300, width: 300, height: 200, label: 'frame' },
  ],
  edges: [],
}

function makeHost(onAddImage?: (file: File) => Promise<string | undefined>) {
  const latest: { canvas: SpatialCanvas } = { canvas: start }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
          onAddImage={onAddImage}
        />
      </div>
    )
  }
  return { Host, latest }
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

function rightClick(el: HTMLElement, x: number, y: number) {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + x,
      clientY: r.top + y,
      button: 2,
    }),
  )
}

async function waitMenu(container: HTMLElement) {
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="context-menu"]')).not.toBeNull(),
  )
}

function menuItem(container: HTMLElement, name: string): HTMLElement | undefined {
  return [...container.querySelectorAll('[data-testid="context-menu"] [role="menuitem"]')].find(
    (el) => (el.textContent ?? '').includes(name),
  ) as HTMLElement | undefined
}

it('the Color row opens a custom color panel and applies a typed hex', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  rightClick(rootOf(container), 200, 150)
  await waitMenu(container)

  const colorGroup = [...container.querySelectorAll('fieldset')].find(
    (g) => g.getAttribute('aria-label') === 'Color',
  ) as HTMLElement
  const trigger = [...colorGroup.querySelectorAll('[role="menuitemradio"]')].find(
    (o) => o.getAttribute('aria-label') === 'Custom color',
  ) as HTMLElement
  expect(trigger).not.toBeNull()
  fireEvent.click(trigger)

  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="custom-color-panel"]')).not.toBeNull(),
  )
  // A real saturation/hue picker is present, not a bare native input.
  expect(container.querySelector('.react-colorful')).not.toBeNull()

  const hexInput = container.querySelector(
    '[data-testid="custom-color-panel"] input',
  ) as HTMLInputElement
  fireEvent.change(hexInput, { target: { value: 'ff00aa' } })
  await vi.waitFor(() =>
    expect(latest.canvas.nodes.find((n) => n.id === 'n1')?.color).toBe('#ff00aa'),
  )
})

it('a group gains Set background image, style options, and Remove background', async () => {
  const { Host, latest } = makeHost(async () => 'stored-bg')
  const { container } = render(<Host />)
  const root = rootOf(container)

  rightClick(root, 550, 400)
  await waitMenu(container)
  const setItem = menuItem(container, 'Set background image')
  expect(setItem).toBeDefined()
  fireEvent.click(setItem as HTMLElement)

  const input = container.querySelector('[data-testid="image-file-input"]') as HTMLInputElement
  const file = new File(['x'], 'photo.png', { type: 'image/png' })
  fireEvent.change(input, { target: { files: [file] } })

  await vi.waitFor(() =>
    expect(latest.canvas.nodes.find((n) => n.id === 'g1')).toMatchObject({
      background: 'stored-bg',
    }),
  )
  // Setting the frame background must NOT also create an image node.
  expect(latest.canvas.nodes).toHaveLength(2)

  // With a background set, the menu offers the style row and removal.
  rightClick(root, 550, 400)
  await waitMenu(container)
  const styleGroup = [...container.querySelectorAll('fieldset')].find(
    (g) => g.getAttribute('aria-label') === 'Background',
  ) as HTMLElement
  expect(styleGroup).toBeDefined()
  const fit = [...styleGroup.querySelectorAll('[role="menuitemradio"]')].find(
    (o) => o.getAttribute('aria-label') === 'Fit',
  ) as HTMLElement
  fireEvent.click(fit)
  await vi.waitFor(() =>
    expect(latest.canvas.nodes.find((n) => n.id === 'g1')).toMatchObject({
      backgroundStyle: 'ratio',
    }),
  )

  fireEvent.click(menuItem(container, 'Remove background') as HTMLElement)
  await vi.waitFor(() =>
    expect(latest.canvas.nodes.find((n) => n.id === 'g1')).not.toHaveProperty('background'),
  )
})
