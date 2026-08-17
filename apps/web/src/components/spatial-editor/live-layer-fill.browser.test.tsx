// canvas-render assigns markdown body runs no `fill` at all — they inherit it
// from the host element (see SpatialEditor's canvas-content). The live drag
// layers host the same markup and did NOT set it, so mid-gesture the body
// text fell back to the UA default black. On the dark canvas that is
// invisible: the node reads as empty for the whole drag and its content
// "returns" only when the committed scene takes it back on release.
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
      <SpatialEditor defaultTool="select" canvas={canvas} onChange={setCanvas} theme="dark" />
    </div>
  )
}

const rootOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

/** The colour the body text actually paints with, resolved through inheritance. */
const paintedFill = (container: HTMLElement, testId: string): string => {
  const host = container.querySelector(`[data-testid="${testId}"]`)
  expect(host).not.toBeNull()
  const text = (host as HTMLElement).querySelector('text')
  expect(text).not.toBeNull()
  return getComputedStyle(text as Element).fill
}

it('paints live drag layers with the same text fill as the committed scene', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  const committed = paintedFill(container, 'canvas-content')

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
  const hr = handle.getBoundingClientRect()
  fireEvent.pointerDown(handle, {
    button: 0,
    pointerId: 2,
    clientX: hr.left + hr.width / 2,
    clientY: hr.top + hr.height / 2,
  })
  fireEvent.pointerMove(root, {
    pointerId: 2,
    clientX: hr.left + hr.width / 2 + 40,
    clientY: hr.top + hr.height / 2 + 30,
  })

  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="live-node"]')).not.toBeNull(),
  )
  expect(paintedFill(container, 'live-node')).toBe(committed)

  fireEvent.pointerUp(root, {
    pointerId: 2,
    clientX: hr.left + hr.width / 2 + 40,
    clientY: hr.top + hr.height / 2 + 30,
  })
})

it('paints the move ghost with the same text fill as the committed scene', async () => {
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  const committed = paintedFill(container, 'canvas-content')

  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 3,
    clientX: r.left + 200,
    clientY: r.top + 150,
  })
  fireEvent.pointerMove(root, { pointerId: 3, clientX: r.left + 260, clientY: r.top + 190 })

  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="drag-preview"] text')).not.toBeNull(),
  )
  expect(paintedFill(container, 'drag-preview')).toBe(committed)

  fireEvent.pointerUp(root, { pointerId: 3, clientX: r.left + 260, clientY: r.top + 190 })
})
