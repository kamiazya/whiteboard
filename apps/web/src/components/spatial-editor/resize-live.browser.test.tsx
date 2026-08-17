// Live re-rendering DURING a resize: the resized node re-renders at its
// preview size every frame and its edges re-route to the moving border —
// mirroring what live drag already guarantees for moves. Assertions taken
// MID-gesture before any pointerup.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { fakeMeasure } from '../../test-utils/fake-measure.js'
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

/** Select node a, grab its EAST resize handle, drag right — no release. */
async function resizeWithoutRelease(container: HTMLElement, dx: number) {
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    pointerId: 4,
    clientX: r.left + 160,
    clientY: r.top + 130,
    buttons: 1,
  })
  fireEvent.pointerUp(root, { pointerId: 4, clientX: r.left + 160, clientY: r.top + 130 })
  await frame()
  const handle = container.querySelector('[data-testid="resize-handle-e"]')
  expect(handle).not.toBeNull()
  handle?.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      clientX: r.left + 220,
      clientY: r.top + 130,
      pointerId: 5,
      button: 0,
    }),
  )
  await frame()
  fireEvent.pointerMove(root, {
    pointerId: 5,
    clientX: r.left + 220 + dx,
    clientY: r.top + 130,
    buttons: 1,
  })
  await frame()
  return root
}

it('re-routes the touched edge to the resized border while the gesture is in flight', async () => {
  const { Host } = makeHost(start)
  const { container } = render(<Host />)
  await resizeWithoutRelease(container, 100)

  const live = container.querySelector('[data-testid="live-edges"]')
  expect(live).not.toBeNull()
  const points = (live?.querySelector('polyline')?.getAttribute('points') ?? '')
    .split(' ')
    .filter((p) => p.length > 0)
    .map((p) => p.split(',').map(Number))
  // a's live right border sits at x = 320 (220 + 100); the edge departs it.
  expect(points[0]?.[0]).toBe(320)
})

it('renders the node itself at its live size, not the committed one', async () => {
  const { Host } = makeHost(start)
  const { container } = render(<Host />)
  await resizeWithoutRelease(container, 100)

  // The static scene no longer paints the node (no stale-size copy) …
  const staticContent = container.querySelector('[data-testid="canvas-content"]')
  expect(staticContent?.innerHTML ?? '').not.toContain('Alpha')
  // … the live node layer paints it at the preview size.
  const liveNode = container.querySelector('[data-testid="live-node"]')
  expect(liveNode).not.toBeNull()
  expect(liveNode?.innerHTML ?? '').toContain('Alpha')
  expect(liveNode?.querySelector('rect')?.getAttribute('width')).toBe('220')
})

it('drops the live layers and commits the resize on release', async () => {
  const { Host, latest } = makeHost(start)
  const { container } = render(<Host />)
  const root = await resizeWithoutRelease(container, 100)
  const r = root.getBoundingClientRect()
  fireEvent.pointerUp(root, { pointerId: 5, clientX: r.left + 320, clientY: r.top + 130 })

  await vi.waitFor(() => {
    expect(latest.canvas.nodes.find((n) => n.id === 'a')).toMatchObject({ width: 220 })
  })
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="live-node"]')).toBeNull()
    expect(container.querySelector('[data-testid="live-edges"]')).toBeNull()
  })
})

it('perf invariant: resize moves after the first re-invoke measure zero times', async () => {
  const measure = vi.fn(fakeMeasure)
  function Host() {
    const [canvas, setCanvas] = useState(start)
    return (
      <div style={{ width: 900, height: 700 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={setCanvas}
          measure={measure}
          theme="light"
        />
      </div>
    )
  }
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    pointerId: 4,
    clientX: r.left + 160,
    clientY: r.top + 130,
    buttons: 1,
  })
  fireEvent.pointerUp(root, { pointerId: 4, clientX: r.left + 160, clientY: r.top + 130 })
  await frame()
  const handle = container.querySelector('[data-testid="resize-handle-e"]')
  handle?.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      clientX: r.left + 220,
      clientY: r.top + 130,
      pointerId: 5,
      button: 0,
    }),
  )
  await frame()
  // First live frame warms the gesture's metrics cache.
  fireEvent.pointerMove(root, {
    pointerId: 5,
    clientX: r.left + 240,
    clientY: r.top + 130,
    buttons: 1,
  })
  await frame()
  const afterFirst = measure.mock.calls.length
  for (const dx of [40, 60, 80]) {
    fireEvent.pointerMove(root, {
      pointerId: 5,
      clientX: r.left + 220 + dx,
      clientY: r.top + 130,
      buttons: 1,
    })
    await frame()
  }
  // Re-wrapping at new widths reuses the cached metrics: zero new calls.
  expect(measure.mock.calls.length).toBe(afterFirst)
})
