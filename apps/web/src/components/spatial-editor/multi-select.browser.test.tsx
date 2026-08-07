// Multi-select slice (a): shift-click membership, group move, batch delete.
// Marquee selection is deliberately deferred — it needs the pan-gesture
// decision recorded on the task. Real pointer input throughout.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 300, y: 100, width: 120, height: 60, text: 'B' },
    { id: 'c', type: 'text', x: 500, y: 100, width: 120, height: 60, text: 'C' },
  ],
  edges: [],
}

let latest: SpatialCanvas = start

function Host() {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  latest = canvas
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor canvas={canvas} onChange={(next) => setCanvas(next)} theme="light" />
    </div>
  )
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

function press(el: HTMLElement, x: number, y: number, opts: { shift?: boolean; id?: number } = {}) {
  const r = el.getBoundingClientRect()
  const base = {
    bubbles: true,
    clientX: r.left + x,
    clientY: r.top + y,
    pointerId: opts.id ?? 5,
    shiftKey: opts.shift ?? false,
  }
  el.dispatchEvent(new PointerEvent('pointerdown', { ...base, button: 0 }))
  el.dispatchEvent(new PointerEvent('pointerup', base))
}

async function frame() {
  await new Promise((r) => requestAnimationFrame(r))
}

it('shift-click adds members; outlines mark them; shift-click again removes', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)

  press(root, 150, 130)
  await frame()
  press(root, 350, 130, { shift: true })
  await frame()

  await vi.waitFor(() => {
    expect(container.querySelectorAll('[data-testid="extra-selection-outlines"] rect').length).toBe(
      1,
    )
  })

  press(root, 350, 130, { shift: true })
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="extra-selection-outlines"]')).toBeNull()
  })
})

it('dragging one member moves every member by the same delta', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)

  press(root, 150, 130)
  await frame()
  press(root, 350, 130, { shift: true })
  await frame()

  // Drag the PRIMARY (a) by (+40, +20).
  const r = root.getBoundingClientRect()
  root.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      clientX: r.left + 150,
      clientY: r.top + 130,
      pointerId: 6,
      button: 0,
    }),
  )
  await frame()
  root.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      clientX: r.left + 190,
      clientY: r.top + 150,
      pointerId: 6,
    }),
  )
  await frame()
  root.dispatchEvent(
    new PointerEvent('pointerup', {
      bubbles: true,
      clientX: r.left + 190,
      clientY: r.top + 150,
      pointerId: 6,
    }),
  )

  await vi.waitFor(() => {
    const a = latest.nodes.find((n) => n.id === 'a')
    const b = latest.nodes.find((n) => n.id === 'b')
    const c = latest.nodes.find((n) => n.id === 'c')
    expect({ a: [a?.x, a?.y], b: [b?.x, b?.y], c: [c?.x, c?.y] }).toEqual({
      a: [140, 120],
      b: [340, 120],
      c: [500, 100],
    })
  })
})

it('Delete removes every member of the multi-selection', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)

  press(root, 150, 130)
  await frame()
  press(root, 350, 130, { shift: true })
  await frame()

  root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))

  await vi.waitFor(() => {
    expect(latest.nodes.map((n) => n.id)).toEqual(['c'])
  })
})
