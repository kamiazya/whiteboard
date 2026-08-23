// An open inspector must not sit on top of the canvas. It did: measured at
// x 540..892 of a 900px editor, so a node under it could not be selected and
// ~18% of the surface was unreachable while it was open.
//
// The fix is layout, not z-order — the editor root IS the pointer surface, so
// anything drawn over it swallows the press no matter what the canvas does.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 40, y: 40, width: 140, height: 80, text: 'A' },
    // Far right — under where the dock used to be drawn.
    { id: 'b', type: 'text', x: 600, y: 30, width: 160, height: 90, text: 'B' },
  ],
  edges: [],
}

function makeHost(width: number) {
  const latest: { canvas: SpatialCanvas } = { canvas: initial }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    latest.canvas = canvas
    return (
      <div style={{ width, height: 600 }}>
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

function openInspector(container: HTMLElement) {
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 100, clientY: r.top + 80 })
  const menu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  fireEvent.click(
    [...menu.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').startsWith('Facets'),
    ) as HTMLElement,
  )
}

it('gives the canvas back the width the dock takes, so nothing sits on it', () => {
  const { Host } = makeHost(900)
  const { container } = render(<Host />)
  const before = rootOf(container).getBoundingClientRect().width
  openInspector(container)

  const panel = container.querySelector('[data-testid="facet-form-panel"]') as HTMLElement
  const rootBox = rootOf(container).getBoundingClientRect()
  const panelBox = panel.getBoundingClientRect()

  // The canvas is narrower by the dock's width...
  expect(rootBox.width).toBeLessThan(before)
  // ...and the two do not overlap at all.
  expect(Math.round(panelBox.left)).toBeGreaterThanOrEqual(Math.round(rootBox.right) - 1)
})

it('leaves no point inside the canvas covered by the inspector', () => {
  const { Host } = makeHost(900)
  const { container } = render(<Host />)
  openInspector(container)

  const panel = container.querySelector('[data-testid="facet-form-panel"]') as HTMLElement
  const r = rootOf(container).getBoundingClientRect()

  // Sample the canvas rather than one point: a single probe passes for the
  // wrong reason wherever it happens to miss the panel, which is how the
  // first version of this test stayed green against the unfixed code.
  const stolen: string[] = []
  for (let fx = 0.05; fx < 1; fx += 0.1) {
    for (let fy = 0.05; fy < 1; fy += 0.1) {
      const x = r.left + r.width * fx
      const y = r.top + r.height * fy
      const hit = document.elementFromPoint(x, y)
      if (hit !== null && panel.contains(hit)) stolen.push(`${Math.round(x)},${Math.round(y)}`)
    }
  }
  expect(stolen).toEqual([])
})

// Reserving the width feeds back into the decision that reserved it: the
// breakpoint was read off the editor root, which the dock had just made
// narrower. Measured one frame apart on a 900px editor — dock 352x600@548,0,
// then sheet 900x253@0,347. Synchronously it looks right, which is why the
// two tests above stayed green through it.
it('keeps the dock docked after the canvas has shrunk under it', async () => {
  const { Host } = makeHost(900)
  const { container } = render(<Host />)
  openInspector(container)

  // SAMPLED over time, not measured once. The shrink and the re-decision are
  // a frame apart, so a single read — or a wait that resolves on the first
  // frame satisfying it — sees the state before the bug. Sampling also
  // catches the oscillating case, where the layout alternates rather than
  // settling wrong; both of those passed earlier versions of this test.
  const offRight: string[] = []
  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 40))
    const p = (
      container.querySelector('[data-testid="facet-form-panel"]') as HTMLElement
    ).getBoundingClientRect()
    const r = rootOf(container).getBoundingClientRect()
    if (Math.round(p.left) < Math.round(r.right) - 1) {
      offRight.push(
        `${i}:root=${Math.round(r.width)}x${Math.round(r.height)} panel@${Math.round(p.left)},${Math.round(p.top)}`,
      )
    }
  }
  expect(offRight).toEqual([])
})
