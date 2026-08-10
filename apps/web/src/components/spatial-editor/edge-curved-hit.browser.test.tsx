// A curved edge is DRAWN as midpoint-quadratic corners, but selection used to
// hit-test and highlight the raw waypoint polyline: tapping the visible curve
// missed the edge, and the blue highlight ran square through corners the ink
// never touches. Both must follow the geometry actually drawn.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// a → b routes as an elbow with a corner at (400,130); the drawn curve's apex
// for that corner is (380,157.5), 20px off the waypoint polyline.
const canvas: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 420, y: 320, width: 120, height: 60, text: 'B' },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
  'x-whiteboard': { edgeRouting: { style: 'curved' } },
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

it('selects a curved edge by clicking the drawn curve, and highlights along it', async () => {
  const { container } = render(
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="select" canvas={canvas} onChange={() => {}} theme="light" />
    </div>,
  )
  const root = rootOf(container)
  await vi.waitFor(() => expect(container.querySelector('svg path[d*="Q"]')).not.toBeNull())

  // The curve's apex — on the ink, 20px away from the waypoint polyline.
  fireEvent.pointerDown(root, { pointerId: 1, clientX: 380, clientY: 157.5, buttons: 1 })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: 380, clientY: 157.5 })

  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )

  // The highlight follows the curve: it passes near the apex and never
  // through the sharp waypoint corner.
  const highlight = container.querySelector(
    '[data-testid="edge-selection-highlight"]',
  ) as SVGPolylineElement
  const points = (highlight.getAttribute('points') ?? '').split(' ').map((pair) => {
    const [x, y] = pair.split(',').map(Number)
    return { x: x as number, y: y as number }
  })
  expect(points.some((p) => Math.hypot(p.x - 380, p.y - 157.5) < 2)).toBe(true)
  expect(points.some((p) => p.x === 400 && p.y === 130)).toBe(false)
})
