// Multi-select slice (a): shift-click membership, group move, batch delete.
// Marquee selection is deliberately deferred — it needs the pan-gesture
// decision recorded on the task. Real pointer input throughout.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
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
    expect(container.querySelectorAll('[data-testid="member-outlines"] rect').length).toBe(2)
  })

  press(root, 350, 130, { shift: true })
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="member-outlines"]')).toBeNull()
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

// Grabbing a NON-primary member must carry the whole selection — the primary
// used to be left behind, so a three-node selection dragged by an extra moved
// only two nodes.
it('dragging a non-primary member moves the primary too', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)

  press(root, 150, 130)
  await frame()
  press(root, 350, 130, { shift: true })
  await frame()
  press(root, 550, 130, { shift: true })
  await frame()

  // Drag extra member b by (+40, +20); primary is a.
  const r = root.getBoundingClientRect()
  root.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      clientX: r.left + 350,
      clientY: r.top + 130,
      pointerId: 6,
      button: 0,
    }),
  )
  await frame()
  root.dispatchEvent(
    new PointerEvent('pointermove', {
      bubbles: true,
      clientX: r.left + 390,
      clientY: r.top + 150,
      pointerId: 6,
    }),
  )
  await frame()
  root.dispatchEvent(
    new PointerEvent('pointerup', {
      bubbles: true,
      clientX: r.left + 390,
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
      c: [540, 120],
    })
  })
})

// Right-clicking OUTSIDE the selection must behave like left-clicking
// outside it: the selection collapses to the target. Keeping the old
// extras alongside a brand-new primary made later move/delete operations
// silently act on nodes the user thought were deselected.
it('a context-menu press on a non-member collapses the selection to it', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)

  press(root, 150, 130)
  await frame()
  press(root, 350, 130, { shift: true })
  await frame()

  // Right-click the unrelated node c.
  const r = root.getBoundingClientRect()
  root.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + 550,
      clientY: r.top + 130,
      button: 2,
    }),
  )
  await frame()

  // No surviving extras: the menu offers no multi-selection actions.
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="context-menu"]')).not.toBeNull(),
  )
  const items = [...container.querySelectorAll('[data-testid="context-menu"] [role="menuitem"]')]
  expect(items.length).toBeGreaterThan(0)
  expect(items.some((el) => (el.textContent ?? '').includes('Group selection'))).toBe(false)
})

// Creating from the palette while a multi-selection exists selects ONLY
// the new node — the old extras must not ride along into the next move.
it('palette creation replaces the whole selection with the new node', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)

  press(root, 150, 130)
  await frame()
  press(root, 350, 130, { shift: true })
  await frame()

  fireEvent.click(container.querySelector('[data-testid="add-button"]') as HTMLElement)
  fireEvent.click(
    [...container.querySelectorAll('[data-testid="add-menu"] [role="menuitem"]')].find(
      (b) => b.getAttribute('aria-label') === 'Note',
    ) as HTMLElement,
  )
  await vi.waitFor(() => expect(latest.nodes.length).toBe(4))
  const created = latest.nodes.find((n) => !['a', 'b', 'c'].includes(n.id)) as {
    id: string
    x: number
    y: number
  }

  // Drag the new node; a and b must stay put.
  const cr = root.getBoundingClientRect()
  const grab = { x: created.x + 20, y: created.y + 20 }
  fireEvent.pointerDown(root, {
    pointerId: 8,
    clientX: cr.left + grab.x,
    clientY: cr.top + grab.y,
    buttons: 1,
  })
  await frame()
  fireEvent.pointerMove(root, {
    pointerId: 8,
    clientX: cr.left + grab.x + 30,
    clientY: cr.top + grab.y + 30,
    buttons: 1,
  })
  await frame()
  fireEvent.pointerUp(root, {
    pointerId: 8,
    clientX: cr.left + grab.x + 30,
    clientY: cr.top + grab.y + 30,
  })

  await vi.waitFor(() => {
    const moved = latest.nodes.find((n) => n.id === created.id)
    expect(moved?.x).not.toBe(created.x)
  })
  expect(latest.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 100, y: 100 })
  expect(latest.nodes.find((n) => n.id === 'b')).toMatchObject({ x: 300, y: 100 })
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

// The member outlines must also mark the edges INSIDE the selected area
// (both endpoints selected) — they follow area actions like recolor, so
// the highlight has to say so before the user commits one.
it('member outlines include the edges between members, not edges leaving the area', async () => {
  const wired: SpatialCanvas = {
    nodes: [
      { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'A' },
      { id: 'b', type: 'text', x: 300, y: 100, width: 120, height: 60, text: 'B' },
      { id: 'c', type: 'text', x: 500, y: 300, width: 120, height: 60, text: 'C' },
    ],
    edges: [
      { id: 'ab', fromNode: 'a', toNode: 'b' },
      { id: 'bc', fromNode: 'b', toNode: 'c' },
    ],
  }
  function WiredHost() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(wired)
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
  const { container } = render(<WiredHost />)
  const root = rootOf(container)

  press(root, 160, 130)
  await frame()
  press(root, 360, 130, { shift: true })
  await frame()

  await vi.waitFor(() =>
    expect(container.querySelectorAll('[data-testid="member-outlines"] rect').length).toBe(2),
  )
  const edgeHighlights = [...container.querySelectorAll('[data-testid="member-outlines"] polyline')]
  expect(edgeHighlights.map((el) => el.getAttribute('data-edge-id'))).toEqual(['ab'])
})
