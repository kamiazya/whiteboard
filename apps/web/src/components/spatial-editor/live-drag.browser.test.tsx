// Live re-rendering DURING a drag: the edges touching the carried nodes
// re-route every frame instead of freezing until drop, and the static
// scene hides what the ghost layer is already drawing — no duplicate node
// left behind at the start position. Real pointer input, assertions taken
// MID-drag before any pointerup.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'Alpha' },
    { id: 'b', type: 'text', x: 500, y: 100, width: 120, height: 60, text: 'Beta' },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
}

function makeHost(initial: SpatialCanvas) {
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

const rootOf = (c: HTMLElement) => c.querySelector('[data-testid="spatial-editor"]') as HTMLElement

const frame = () => new Promise((r) => requestAnimationFrame(r))

async function dragWithoutRelease(root: HTMLElement, from: [number, number], to: [number, number]) {
  const r = root.getBoundingClientRect()
  await Promise.resolve(
    fireEvent.pointerDown(root, {
      pointerId: 7,
      clientX: r.left + from[0],
      clientY: r.top + from[1],
      buttons: 1,
    }),
  )
  await frame()
  fireEvent.pointerMove(root, {
    pointerId: 7,
    clientX: r.left + to[0],
    clientY: r.top + to[1],
    buttons: 1,
  })
  await frame()
}

it('re-routes the touched edge live while the drag is in flight', async () => {
  const { Host } = makeHost(start)
  const { container } = render(<Host />)
  const root = rootOf(container)

  // Grab Alpha at (160, 130), move +100,+150 — no release.
  await dragWithoutRelease(root, [160, 130], [260, 280])

  const live = container.querySelector('[data-testid="live-edges"]')
  expect(live).not.toBeNull()
  const polyline = live?.querySelector('polyline')
  expect(polyline).not.toBeNull()
  // Alpha's live box is (200, 250); the edge leaves its right-center at
  // (320, 280) toward Beta's left-center (500, 130).
  const [sx, sy] = (polyline?.getAttribute('points') ?? '').split(' ')[0]?.split(',') ?? []
  expect(Number(sx)).toBeCloseTo(320, 0)
  expect(Number(sy)).toBeCloseTo(280, 0)

  // The static scene no longer draws the frozen edge — the live layer owns it.
  const staticPolylines = [
    ...container.querySelectorAll('[data-testid="viewport-transform"] svg polyline'),
  ].filter((el) => el.closest('[data-testid="live-edges"]') === null)
  expect(staticPolylines).toHaveLength(0)
})

it('drops the live layer and restores the committed scene on release', async () => {
  const { Host, latest } = makeHost(start)
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  await dragWithoutRelease(root, [160, 130], [260, 280])
  fireEvent.pointerUp(root, { pointerId: 7, clientX: r.left + 260, clientY: r.top + 280 })

  await vi.waitFor(() => {
    expect(latest.canvas.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 200, y: 250 })
  })
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="live-edges"]')).toBeNull()
  })
  // The committed scene draws the edge again.
  await vi.waitFor(() => {
    expect(
      container.querySelectorAll('[data-testid="viewport-transform"] svg polyline').length,
    ).toBe(1)
  })
})

it('a multi-selection ghost carries every member, not only the grabbed node', async () => {
  const trio: SpatialCanvas = {
    nodes: [
      { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'Alpha' },
      { id: 'c', type: 'text', x: 100, y: 300, width: 120, height: 60, text: 'Gamma' },
      { id: 'b', type: 'text', x: 500, y: 100, width: 120, height: 60, text: 'Beta' },
    ],
    edges: [],
  }
  const { Host } = makeHost(trio)
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  // Select Alpha, shift-add Gamma.
  fireEvent.pointerDown(root, {
    pointerId: 5,
    clientX: r.left + 160,
    clientY: r.top + 130,
    buttons: 1,
  })
  fireEvent.pointerUp(root, { pointerId: 5, clientX: r.left + 160, clientY: r.top + 130 })
  await frame()
  fireEvent.pointerDown(root, {
    pointerId: 5,
    clientX: r.left + 160,
    clientY: r.top + 330,
    buttons: 1,
    shiftKey: true,
  })
  fireEvent.pointerUp(root, {
    pointerId: 5,
    clientX: r.left + 160,
    clientY: r.top + 330,
    shiftKey: true,
  })
  await frame()

  await dragWithoutRelease(root, [160, 130], [220, 160])

  const ghost = container.querySelector('[data-testid="drag-preview"]')
  expect(ghost?.innerHTML ?? '').toContain('Alpha')
  expect(ghost?.innerHTML ?? '').toContain('Gamma')
  expect(ghost?.innerHTML ?? '').not.toContain('Beta')
})
