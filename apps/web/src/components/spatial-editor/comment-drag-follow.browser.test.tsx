// A node-anchored comment is drawn at its target's top-right corner, so
// while that node travels as the drag ghost the comment must travel with
// it — not stay behind on the backdrop at the pre-drag corner and jump on
// drop. A point-anchored comment on the same canvas is NOT carried: it
// belongs to the backdrop for the whole gesture. Real browser, because the
// drag layers (ghost fragment + backdrop patch) are what is under test.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' }],
  edges: [],
  'x-whiteboard': {
    comments: [
      {
        id: 'c-node',
        x: 300,
        y: 100,
        text: 'anchored note',
        createdAt: '2026-09-02T00:00:00.000Z',
        targetNodeId: 'n1',
      },
      { id: 'c-free', x: 600, y: 450, text: 'free note', createdAt: '2026-09-02T00:00:00.000Z' },
    ],
  },
}

function Host() {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="select" canvas={canvas} onChange={setCanvas} theme="light" />
    </div>
  )
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

function textOf(container: HTMLElement, testId: string): string {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? ''
}

it('a node-anchored comment travels with the move ghost; a point comment stays on the backdrop', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  await vi.waitFor(() => expect(textOf(container, 'canvas-content')).toContain('anchored note'))

  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 200,
    clientY: r.top + 150,
  })
  await new Promise((resolve) => requestAnimationFrame(resolve))
  fireEvent.pointerMove(root, { pointerId: 1, clientX: r.left + 260, clientY: r.top + 190 })

  await vi.waitFor(() => expect(textOf(container, 'drag-preview')).toContain('hello'))
  // The comment rides the ghost, and is drawn exactly once: the backdrop
  // must not keep a stale copy at the pre-drag corner.
  expect(textOf(container, 'drag-preview')).toContain('anchored note')
  expect(textOf(container, 'canvas-content')).not.toContain('anchored note')
  // The point-anchored comment is nobody's passenger.
  expect(textOf(container, 'drag-preview')).not.toContain('free note')
  expect(textOf(container, 'canvas-content')).toContain('free note')

  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 260, clientY: r.top + 190 })
  await vi.waitFor(() => expect(container.querySelector('[data-testid="drag-preview"]')).toBeNull())
  expect(textOf(container, 'canvas-content')).toContain('anchored note')
})

it('a node-anchored comment follows the corner of a node being resized', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  // Select the node so its resize handles mount.
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 2,
    clientX: r.left + 200,
    clientY: r.top + 150,
  })
  fireEvent.pointerUp(root, { pointerId: 2, clientX: r.left + 200, clientY: r.top + 150 })
  const handle = await vi.waitFor(() => {
    const el = container.querySelector('[data-testid="resize-handle-se"]')
    expect(el).not.toBeNull()
    return el as SVGElement
  })
  const hr = handle.getBoundingClientRect()
  fireEvent.pointerDown(handle, {
    button: 0,
    pointerId: 3,
    clientX: hr.left + hr.width / 2,
    clientY: hr.top + hr.height / 2,
  })
  fireEvent.pointerMove(root, {
    pointerId: 3,
    clientX: hr.left + hr.width / 2 + 40,
    clientY: hr.top + hr.height / 2 + 30,
  })

  await vi.waitFor(() => expect(textOf(container, 'live-node')).toContain('hello'))
  expect(textOf(container, 'live-node')).toContain('anchored note')
  expect(textOf(container, 'canvas-content')).not.toContain('anchored note')
  expect(textOf(container, 'canvas-content')).toContain('free note')

  fireEvent.pointerUp(root, {
    pointerId: 3,
    clientX: hr.left + hr.width / 2 + 40,
    clientY: hr.top + hr.height / 2 + 30,
  })
})
