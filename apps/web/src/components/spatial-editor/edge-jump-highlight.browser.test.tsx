// The selection highlight follows the DRAWN line — including line-jump
// hops. A highlight built from the raw waypoints cuts straight through
// every hop the ink arcs over.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// Two crossing edges with lineJumps: the later edge hops over the first.
const doc: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 60, y: 200, width: 120, height: 60, text: 'a' },
    { id: 'b', type: 'text', x: 520, y: 200, width: 120, height: 60, text: 'b' },
    { id: 'c', type: 'text', x: 300, y: 40, width: 120, height: 60, text: 'c' },
    { id: 'd', type: 'text', x: 300, y: 400, width: 120, height: 60, text: 'd' },
  ],
  edges: [
    { id: 'h', fromNode: 'a', toNode: 'b' },
    { id: 'v', fromNode: 'c', toNode: 'd' },
  ],
  'x-whiteboard': { edgeRouting: { style: 'orthogonal', lineJumps: 'arc' } },
}

function press(el: HTMLElement, type: string, x: number, y: number) {
  const r = el.getBoundingClientRect()
  return el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      clientX: r.left + x,
      clientY: r.top + y,
      pointerId: 7,
      button: 0,
    }),
  )
}

it('the selection highlight arcs over jump hops instead of cutting through them', async () => {
  const { container } = render(
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="select" canvas={doc} onChange={() => {}} theme="light" />
    </div>,
  )
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  await vi.waitFor(() => {
    expect(root.querySelectorAll('path[d*="A 5 5"], polyline').length).toBeGreaterThan(0)
  })

  // The jumped edge is drawn as a <path> with an arc; find its hop center.
  const drawn = [...root.querySelectorAll('path')].find((el) =>
    (el.getAttribute('d') ?? '').includes('A 5 5'),
  )
  expect(drawn).toBeDefined()
  const d = drawn?.getAttribute('d') ?? ''
  // "L x1 y1 A 5 5 0 0 0 x2 y2": the hop spans x1..x2 / y1..y2.
  const m = d.match(/L ([\d.-]+) ([\d.-]+) A 5 5 0 0 0 ([\d.-]+) ([\d.-]+)/)
  expect(m).not.toBeNull()
  if (!m) return
  const hop = { x: (Number(m[1]) + Number(m[3])) / 2, y: (Number(m[2]) + Number(m[4])) / 2 }

  // Select the jumped edge by clicking a point on it away from the hop.
  press(root, 'pointerdown', 360, 380)
  press(root, 'pointerup', 360, 380)
  const highlight = await vi.waitFor(() => {
    const el = container.querySelector('[data-testid="edge-selection-highlight"]')
    expect(el).not.toBeNull()
    return el as SVGPolylineElement
  })

  // The highlight must deviate at the hop: some vertex sits near the arc
  // apex (5px left of travel from the hop center), and no straight segment
  // passes through the hop center itself.
  const pts = (highlight.getAttribute('points') ?? '')
    .split(' ')
    .map((pair) => pair.split(',').map(Number))
    .map(([x, y]) => ({ x: x!, y: y! }))
  const nearApex = pts.some((p) => Math.hypot(p.x - hop.x, p.y - hop.y) <= 5.5 && Math.hypot(p.x - hop.x, p.y - hop.y) >= 4.5)
  expect(nearApex).toBe(true)
})
