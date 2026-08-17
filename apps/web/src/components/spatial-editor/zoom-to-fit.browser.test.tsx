// Zoom to fit / zoom to selection (editor-completeness slice 7): surface
// the viewport framing the editor could already compute. Shift+1 frames
// everything, Shift+2 frames the selection; the hand-mode dock's framing
// button is the touch path.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// Content far wider than the 800x600 host, so fitting MUST zoom out.
const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 400, height: 200, text: 'A' },
    { id: 'b', type: 'text', x: 2000, y: 1200, width: 400, height: 200, text: 'B' },
  ],
  edges: [],
}

function makeHost() {
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
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
  return { Host }
}

const rootOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

const zoomOf = (container: HTMLElement) => {
  const vt = container.querySelector('[data-testid="viewport-transform"]') as HTMLElement
  return Number(/scale\(([\d.]+)\)/.exec(vt.style.transform)?.[1])
}

/** Every node's on-screen box, relative to the editor root. */
function nodeBoxes(container: HTMLElement) {
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  return [...container.querySelectorAll('[data-testid="viewport-transform"] svg rect')]
    .map((el) => el.getBoundingClientRect())
    .filter((b) => b.width > 20)
    .map((b) => ({
      left: b.x - r.x,
      top: b.y - r.y,
      right: b.x + b.width - r.x,
      bottom: b.y + b.height - r.y,
    }))
}

it('Shift+1 frames ALL content inside the viewport (zooming out when it does not fit)', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  expect(zoomOf(container)).toBe(1)

  fireEvent.keyDown(root, { code: 'Digit1', key: '!', shiftKey: true })

  expect(zoomOf(container)).toBeLessThan(1)
  const r = root.getBoundingClientRect()
  for (const box of nodeBoxes(container)) {
    expect(box.left).toBeGreaterThanOrEqual(-1)
    expect(box.top).toBeGreaterThanOrEqual(-1)
    expect(box.right).toBeLessThanOrEqual(r.width + 1)
    expect(box.bottom).toBeLessThanOrEqual(r.height + 1)
  }
})

it('Shift+2 frames only the SELECTION, filling more of the viewport than fit-all', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  fireEvent.keyDown(root, { code: 'Digit1', key: '!', shiftKey: true })
  const fitAllZoom = zoomOf(container)

  // Select node A at its ACTUAL rendered position after the fit (the
  // framed layout is what a user would be clicking).
  const first = nodeBoxes(container)[0]
  const cx = r.left + (first.left + first.right) / 2
  const cy = r.top + (first.top + first.bottom) / 2
  fireEvent.pointerDown(root, { button: 0, pointerId: 1, clientX: cx, clientY: cy })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: cx, clientY: cy })
  expect(container.querySelector('[data-testid="selection-overlay"]')).not.toBeNull()

  fireEvent.keyDown(root, { code: 'Digit2', key: '@', shiftKey: true })
  expect(zoomOf(container)).toBeGreaterThan(fitAllZoom)
})

it('Shift+2 without a selection falls back to framing everything', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  fireEvent.keyDown(root, { code: 'Digit2', key: '@', shiftKey: true })
  expect(zoomOf(container)).toBeLessThan(1)
})

it("hand mode's dock button frames the content as the touch path", () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  fireEvent.click(container.querySelector('[data-testid="hand-tool-button"]') as HTMLElement)
  const button = container.querySelector('[data-testid="zoom-fit-button"]') as HTMLElement
  expect(button).not.toBeNull()
  fireEvent.click(button)
  expect(zoomOf(container)).toBeLessThan(1)
})
