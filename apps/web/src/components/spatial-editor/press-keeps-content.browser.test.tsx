// A press hands the node from the committed scene to the live layers
// immediately, but the live layers derive from the pointer — so between the
// press and the first move there was a window where NOTHING drew the node.
// Measured on a real drag: the committed layer dropped the node 4ms after
// pointerdown and the live layer appeared 65ms later. Hold a handle without
// moving and the box stays empty for as long as you hold, which reads as the
// content being lost rather than as a gesture starting.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [{ id: 'a', type: 'text', x: 100, y: 100, width: 220, height: 100, text: 'hello resize' }],
  edges: [],
}

function Host() {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="select" canvas={canvas} onChange={setCanvas} theme="light" />
    </div>
  )
}

const rootOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

const textOf = (container: HTMLElement, testId: string) =>
  container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? ''

it('keeps the node content visible while a resize handle is held still', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 200,
    clientY: r.top + 150,
  })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 200, clientY: r.top + 150 })
  const handle = await vi.waitFor(() => {
    const el = container.querySelector('[data-testid="resize-handle-se"]')
    expect(el).not.toBeNull()
    return el as SVGElement
  })

  // The press alone — no pointermove, the way a finger lands on a handle
  // before it starts to drag.
  fireEvent.pointerDown(handle, {
    button: 0,
    pointerId: 2,
    clientX: r.left + 320,
    clientY: r.top + 200,
  })

  // The gesture really did start (otherwise the assertion below would pass
  // on a canvas that simply never handed the node over).
  await vi.waitFor(() => expect(textOf(container, 'canvas-content')).not.toContain('hello resize'))
  const live = await vi.waitFor(() => {
    const el = container.querySelector('[data-testid="live-node"]')
    expect(el).not.toBeNull()
    return el as HTMLElement
  })
  expect(live.textContent).toContain('hello resize')

  fireEvent.pointerUp(root, { pointerId: 2, clientX: r.left + 320, clientY: r.top + 200 })
})

it('keeps the node content visible while a grabbed node is held still', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 3,
    clientX: r.left + 200,
    clientY: r.top + 150,
  })

  await vi.waitFor(() => expect(textOf(container, 'canvas-content')).not.toContain('hello resize'))
  await vi.waitFor(() => expect(textOf(container, 'drag-preview')).toContain('hello resize'))

  fireEvent.pointerUp(root, { pointerId: 3, clientX: r.left + 200, clientY: r.top + 150 })
})
