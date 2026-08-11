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

it('re-routes a bystander edge live when the dragged node lands on its path', async () => {
  // `a` has no edges; c—d run a straight line the drag will block. On drop
  // the router detours around `a`, so mid-drag must already show the detour
  // or the preview disagrees with the committed result.
  const blocked: SpatialCanvas = {
    nodes: [
      { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'Mover' },
      { id: 'c', type: 'text', x: 100, y: 300, width: 120, height: 60, text: 'From' },
      { id: 'd', type: 'text', x: 700, y: 300, width: 120, height: 60, text: 'To' },
    ],
    edges: [{ id: 'e-cd', fromNode: 'c', toNode: 'd' }],
  }
  const { Host } = makeHost(blocked)
  const { container } = render(<Host />)
  const root = rootOf(container)

  // Grab Mover at (160, 130), park it on the c—d line (+240, +200).
  await dragWithoutRelease(root, [160, 130], [400, 330])

  const live = container.querySelector('[data-testid="live-edges"]')
  expect(live).not.toBeNull()
  const points = (live?.querySelector('polyline')?.getAttribute('points') ?? '')
    .split(' ')
    .filter((p) => p.length > 0)
  // A straight c—d line is two points; the detour around Mover is more.
  expect(points.length).toBeGreaterThan(2)

  // The live layer owns EVERY edge during the drag — none stay frozen.
  const staticPolylines = [
    ...container.querySelectorAll('[data-testid="canvas-content"] svg polyline'),
  ]
  expect(staticPolylines).toHaveLength(0)
})

it('recomputes line jumps live while the drag is in flight', async () => {
  // e2 starts clear of e1; dragging `d` up makes e2 cross e1. Jumps are
  // enabled, so the drop result hops e2 over e1 — the live preview must too.
  const crossing: SpatialCanvas = {
    nodes: [
      { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'A' },
      { id: 'b', type: 'text', x: 700, y: 100, width: 120, height: 60, text: 'B' },
      { id: 'c', type: 'text', x: 350, y: 300, width: 120, height: 60, text: 'C' },
      { id: 'd', type: 'text', x: 350, y: 600, width: 120, height: 60, text: 'D' },
    ],
    edges: [
      { id: 'e1', fromNode: 'a', toNode: 'b' },
      { id: 'e2', fromNode: 'c', toNode: 'd' },
    ],
    'x-whiteboard': { edgeRouting: { lineJumps: 'arc' } },
  }
  const { Host } = makeHost(crossing)
  const { container } = render(<Host />)
  const root = rootOf(container)

  // Grab D at (410, 630), move it above the a—b line (to y 30).
  await dragWithoutRelease(root, [410, 630], [410, 30])

  const live = container.querySelector('[data-testid="live-edges"]')
  expect(live).not.toBeNull()
  const jumpPaths = [...(live?.querySelectorAll('path') ?? [])].filter((p) =>
    (p.getAttribute('d') ?? '').includes('A 5 5'),
  )
  expect(jumpPaths.length).toBeGreaterThan(0)
})

it('keeps a touched edge label visible and centered during the drag', async () => {
  const labelled: SpatialCanvas = {
    ...start,
    edges: [{ id: 'e1', fromNode: 'a', toNode: 'b', label: 'flow' }],
  }
  const { Host } = makeHost(labelled)
  const { container } = render(<Host />)
  const root = rootOf(container)

  await dragWithoutRelease(root, [160, 130], [260, 280])

  const live = container.querySelector('[data-testid="live-edges"]')
  expect(live?.innerHTML ?? '').toContain('flow')
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

  // Every member is travelling with the ghost, so the membership outlines
  // (boxes AND internal-edge highlights, both derived from the committed
  // scene) would mark stale geometry — they hide until the drop.
  expect(container.querySelector('[data-testid="member-outlines"]')).toBeNull()
})

it('freezes edge sides at their committed choices for the whole drag', async () => {
  // Committed: yellow sits below-right of red, so the optimizer settles
  // orange onto red's RIGHT side. The drag hauls yellow far to red's LEFT
  // — a fresh optimization of the moved canvas would flip the arrival to
  // red's left side, so the live layer still routing to the RIGHT border
  // is only explainable by the frozen committed sides.
  const crossing: SpatialCanvas = {
    nodes: [
      { id: 'red', type: 'text', x: 300, y: 100, width: 200, height: 100, text: 'Red' },
      { id: 'yellow', type: 'text', x: 620, y: 300, width: 160, height: 90, text: 'Yellow' },
      { id: 'cyan', type: 'text', x: 700, y: 520, width: 160, height: 90, text: 'Cyan' },
    ],
    edges: [
      { id: 'e-orange', fromNode: 'yellow', toNode: 'red' },
      { id: 'e-red', fromNode: 'red', toNode: 'cyan' },
    ],
    'x-whiteboard': { edgeRouting: { style: 'orthogonal' } },
  }
  const { Host } = makeHost(crossing)
  const { container } = render(<Host />)
  const root = rootOf(container)

  // Grab Yellow at its center (700, 345) and haul it left of Red — no release.
  await dragWithoutRelease(root, [700, 345], [80, 345])

  const live = container.querySelector('[data-testid="live-edges"]')
  expect(live).not.toBeNull()
  // The orange arrival still terminates ON red's right border (x = 500),
  // exactly where the committed render put it.
  const points = [...(live?.querySelectorAll('polyline') ?? [])].flatMap((p) =>
    (p.getAttribute('points') ?? '').split(' ').map((pair) => pair.split(',').map(Number)),
  )
  expect(points.some(([x, y]) => x === 500 && y! >= 100 && y! <= 200)).toBe(true)
})
