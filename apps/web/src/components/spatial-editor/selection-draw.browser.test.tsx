// The selection outline draws itself once (~150ms) and stops — BRAND.md's
// motion grammar brought to the canvas: draw once, never loop, and the
// global prefers-reduced-motion collapse (index.css) lands it instantly on
// the finished form because the motion is a CSS animation, not JS.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 100, y: 100, width: 150, height: 80, text: 'a' },
    { id: 'b', type: 'text', x: 400, y: 300, width: 150, height: 80, text: 'b' },
  ],
  edges: [],
}

function renderHost() {
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
  return render(<Host />)
}

function clickNode(container: HTMLElement, at: [number, number]) {
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + at[0],
    clientY: r.top + at[1],
  })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + at[0], clientY: r.top + at[1] })
}

const outlineOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="selection-outline"]') as SVGRectElement

it('the outline is a CSS draw-once animation, so the reduced-motion collapse governs it', () => {
  const { container } = renderHost()
  clickNode(container, [175, 140])

  const outline = outlineOf(container)
  const style = getComputedStyle(outline)
  expect(style.animationName).toBe('selection-draw')
  // Never loop: one iteration, and it holds the finished state.
  expect(style.animationIterationCount).toBe('1')
  expect(style.animationFillMode).toContain('both')
})

it('selecting a DIFFERENT node draws again; dragging the same one does not remount', () => {
  const { container } = renderHost()
  clickNode(container, [175, 140])
  const first = outlineOf(container)

  clickNode(container, [475, 340])
  const second = outlineOf(container)
  // A new element per selection target is what restarts the CSS animation.
  expect(second).not.toBe(first)

  // Same target re-selected mid-session keeps the element: no replay storm.
  clickNode(container, [475, 340])
  expect(outlineOf(container)).toBe(second)
})
