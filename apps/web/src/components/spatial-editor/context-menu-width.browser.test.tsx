// An options row is a picker, so an option pushed past the editor's own edge
// is not merely ugly — it cannot be tapped. jsdom has no layout, so this is
// only measurable in a real browser: every jsdom test stayed green while the
// phone clipped Color, Shape and Symbol alike.
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

/** Narrower than MINIMAP_MIN_ROOT_WIDTH_PX, so the ⋯ menu opens as a sheet. */
function renderNarrow(width: number) {
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    return (
      <div style={{ width, height: 700 }}>
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

/** Options that stick out of `bounds`, reported by name so a failure names them. */
function escaping(menu: HTMLElement, bounds: DOMRect) {
  return [...menu.querySelectorAll('fieldset button')]
    .map((el) => ({ label: el.getAttribute('aria-label') ?? '?', box: el.getBoundingClientRect() }))
    .filter(({ box }) => box.right > bounds.right + 0.5 || box.left < bounds.left - 0.5)
    .map(({ label, box }) => `${label} @${Math.round(box.left)}..${Math.round(box.right)}`)
}

it('the right-click menu fits the editor width on a phone', () => {
  const { container } = renderNarrow(390)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 120, clientY: r.top + 100 })

  const menu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  // The MENU is what overflows here: `width: max-content` lets an options
  // row set the box wider than the editor, and no clamp can place a box
  // that does not fit.
  expect(menu.getBoundingClientRect().width).toBeLessThanOrEqual(r.width)
  expect(escaping(menu, r)).toEqual([])
  // An empty menu would fit trivially.
  expect(menu.querySelectorAll('fieldset button').length).toBeGreaterThan(10)
})

it('the ⋯ sheet keeps every option inside its own edges', () => {
  const { container } = renderNarrow(390)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    pointerId: 1,
    isPrimary: true,
    clientX: r.left + 130,
    clientY: r.top + 100,
  })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 130, clientY: r.top + 100 })
  // pointerup, not click: the ⋯ fires there (the root preventDefaults
  // touchstart, so a tap never produces a click).
  fireEvent.pointerUp(container.querySelector('[data-testid="more-actions-handle"]') as Element, {
    pointerId: 2,
  })

  const menu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  expect(menu.getAttribute('data-variant')).toBe('sheet')
  // The sheet spans the editor, so here the options overflow the SHEET.
  expect(escaping(menu, menu.getBoundingClientRect())).toEqual([])
})
