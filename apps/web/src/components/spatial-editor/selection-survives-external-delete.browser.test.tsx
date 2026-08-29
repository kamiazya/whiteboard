// A selection may not outlive the node it names. Found by the command-based
// property in editor-state.property.test.ts (`press(#0) →
// replaceCanvas(keep=0000)` left the pressed node selected); this is the same
// state reached the way a user reaches it — an undo, or a peer's delete,
// removing the primary out from under a live multi-selection.
//
// The stale id is invisible: every read site filters the selection by
// laid-out box, so the survivors keep drawing their outlines. What it
// disables is the verbs, whose branches are gated on the PRIMARY having a
// box — which is why the assertion here is on Delete, not on the outlines.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
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
let dropPrimary: () => void = () => {}

function Host() {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  const [externalVersion, setExternalVersion] = useState(0)
  latest = canvas
  dropPrimary = () => {
    setCanvas((current) => ({ ...current, nodes: current.nodes.filter((n) => n.id !== 'a') }))
    setExternalVersion((v) => v + 1)
  }
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvas}
        externalVersion={externalVersion}
        onChange={(next) => setCanvas(next)}
        theme="light"
      />
    </div>
  )
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

function press(el: HTMLElement, x: number, y: number, shift = false) {
  const r = el.getBoundingClientRect()
  const base = {
    bubbles: true,
    clientX: r.left + x,
    clientY: r.top + y,
    pointerId: 5,
    shiftKey: shift,
  }
  el.dispatchEvent(new PointerEvent('pointerdown', { ...base, button: 0 }))
  el.dispatchEvent(new PointerEvent('pointerup', base))
}

async function frame() {
  await new Promise((r) => requestAnimationFrame(r))
}

it('Delete still removes the survivors after an undo drops the primary', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)

  press(root, 150, 130)
  await frame()
  press(root, 350, 130, true)
  await frame()
  press(root, 550, 130, true)
  await vi.waitFor(() => {
    expect(container.querySelectorAll('[data-testid="member-outlines"] rect').length).toBe(3)
  })

  dropPrimary()
  await vi.waitFor(() => {
    expect(latest.nodes.map((n) => n.id)).toEqual(['b', 'c'])
  })
  // The survivors still read as selected...
  await vi.waitFor(() => {
    expect(container.querySelectorAll('[data-testid="member-outlines"] rect').length).toBe(2)
  })
  // ...and the handles come back, because a survivor was promoted to primary
  // rather than the selection being left headless.
  expect(container.querySelector('[data-testid="selection-overlay"]')).not.toBeNull()

  root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
  await vi.waitFor(() => {
    expect(latest.nodes.map((n) => n.id)).toEqual([])
  })
})
