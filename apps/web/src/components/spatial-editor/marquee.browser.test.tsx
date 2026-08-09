// Excalidraw gesture semantics (user decision): plain left-drag on empty
// space marquee-selects intersecting nodes; panning moves to Space+drag or
// middle-button drag (wheel pan unchanged). The stationary empty double
// press still creates a node, resolved at the release.
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
    { id: 'c', type: 'text', x: 600, y: 400, width: 120, height: 60, text: 'C' },
  ],
  edges: [],
}

let latest: SpatialCanvas = start

function Host() {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  latest = canvas
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

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

function ev(el: HTMLElement, type: string, x: number, y: number, extra: PointerEventInit = {}) {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      clientX: r.left + x,
      clientY: r.top + y,
      pointerId: 9,
      button: type === 'pointerdown' ? (extra.button ?? 0) : undefined,
      ...extra,
    }),
  )
}

async function frame() {
  await new Promise((r) => requestAnimationFrame(r))
}

it('plain drag on empty space marquee-selects the intersecting nodes', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)

  // Sweep (50,50) → (460,200): covers a and b, not c.
  ev(root, 'pointerdown', 50, 50)
  await frame()
  ev(root, 'pointermove', 260, 130)
  await frame()
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="marquee-rect"]')).not.toBeNull()
  })
  ev(root, 'pointermove', 460, 200)
  await frame()
  ev(root, 'pointerup', 460, 200)

  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="marquee-rect"]')).toBeNull()
    // One overlay for the region the handles act on, one outline per member.
    expect(container.querySelectorAll('[data-testid="selection-overlay"]').length).toBe(1)
    expect(container.querySelectorAll('[data-testid="member-outlines"] rect').length).toBe(2)
  })
})

it('middle-button drag pans instead of selecting', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)

  ev(root, 'pointerdown', 400, 300, { button: 1 })
  await frame()
  ev(root, 'pointermove', 440, 320)
  await frame()
  ev(root, 'pointerup', 440, 320)

  await vi.waitFor(() => {
    const wrapper = container.querySelector<HTMLElement>('[data-testid="viewport-transform"]')
    expect(wrapper?.style.transform).toBe('scale(1) translate(40px, 20px)')
  })
  expect(container.querySelector('[data-testid="selection-overlay"]')).toBeNull()
})

it('a stationary empty double press still creates a node at the point', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)

  ev(root, 'pointerdown', 500, 500)
  ev(root, 'pointerup', 500, 500)
  await frame()
  ev(root, 'pointerdown', 500, 500)
  ev(root, 'pointerup', 500, 500)

  await vi.waitFor(() => {
    expect(latest.nodes.length).toBe(4)
    expect(container.querySelector('textarea')).not.toBeNull()
  })
})
