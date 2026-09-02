// ADR-0025: a point-anchored comment's pin is draggable — the anchor moves
// and the bubble follows — committing one `move-comment`. A node-anchored
// comment's pin is not: its anchor IS the node's corner, and moving the
// node is how it moves. Real browser: the pin is hit-tested against the
// laid-out scene, which only exists once the editor has rendered.
import type { CanvasComment, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { EditorCommand } from './commands.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const FREE: CanvasComment = {
  id: 'c-free',
  x: 600,
  y: 450,
  text: 'free note',
  createdAt: '2026-09-02T00:00:00.000Z',
}
const ANCHORED: CanvasComment = {
  id: 'c-node',
  x: 300,
  y: 100,
  text: 'anchored note',
  createdAt: '2026-09-02T00:00:00.000Z',
  targetNodeId: 'n1',
}
const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' }],
  edges: [],
  'x-whiteboard': { comments: [ANCHORED, FREE] },
}

function makeHost() {
  const latest: { canvas: SpatialCanvas; commands: EditorCommand[] } = {
    canvas: start,
    commands: [],
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next, command) => {
            latest.commands.push(command)
            setCanvas(next)
          }}
          theme="light"
        />
      </div>
    )
  }
  return { Host, latest }
}

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

function commentOf(canvas: SpatialCanvas, id: string): CanvasComment | undefined {
  return canvas['x-whiteboard']?.comments?.find((c) => c.id === id)
}

function movesOf(commands: readonly EditorCommand[]) {
  return commands.filter((c) => c.kind === 'move-comment')
}

it('dragging a point-anchored pin moves the anchor and commits one move-comment', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'free note',
    ),
  )

  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 600,
    clientY: r.top + 450,
  })
  await new Promise((resolve) => requestAnimationFrame(resolve))
  fireEvent.pointerMove(root, { pointerId: 1, clientX: r.left + 660, clientY: r.top + 500 })
  // A live preview travels with the pointer; the committed chrome is not
  // left behind as a second copy.
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="comment-drag-preview"]')).not.toBeNull(),
  )
  expect(movesOf(latest.commands)).toHaveLength(0)

  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 660, clientY: r.top + 500 })
  await vi.waitFor(() => expect(movesOf(latest.commands)).toHaveLength(1))
  expect(movesOf(latest.commands)[0]).toEqual({
    kind: 'move-comment',
    id: 'c-free',
    x: 660,
    y: 500,
  })
  expect(commentOf(latest.canvas, 'c-free')).toMatchObject({ x: 660, y: 500, text: 'free note' })
  expect(container.querySelector('[data-testid="comment-drag-preview"]')).toBeNull()
  // The press selected nothing and created nothing.
  expect(latest.canvas.nodes).toHaveLength(1)
})

it('a press on a pin that does not travel is not a move', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'free note',
    ),
  )
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 2,
    clientX: r.left + 600,
    clientY: r.top + 450,
  })
  fireEvent.pointerUp(root, { pointerId: 2, clientX: r.left + 600, clientY: r.top + 450 })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(movesOf(latest.commands)).toHaveLength(0)
  expect(commentOf(latest.canvas, 'c-free')).toMatchObject({ x: 600, y: 450 })
})

it('a pointercancel mid-drag writes nothing, and the torn-down drag cannot commit on a later release', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'free note',
    ),
  )
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 4,
    clientX: r.left + 600,
    clientY: r.top + 450,
  })
  await new Promise((resolve) => requestAnimationFrame(resolve))
  fireEvent.pointerMove(root, { pointerId: 4, clientX: r.left + 640, clientY: r.top + 480 })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="comment-drag-preview"]')).not.toBeNull(),
  )
  fireEvent.pointerCancel(root, { pointerId: 4 })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="comment-drag-preview"]')).toBeNull(),
  )
  // The platform tore the drag down: a later move/release from the same
  // pointer must not revive it into a commit.
  fireEvent.pointerMove(root, { pointerId: 4, clientX: r.left + 700, clientY: r.top + 520 })
  fireEvent.pointerUp(root, { pointerId: 4, clientX: r.left + 700, clientY: r.top + 520 })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(movesOf(latest.commands)).toHaveLength(0)
  expect(commentOf(latest.canvas, 'c-free')).toMatchObject({ x: 600, y: 450 })
})

it('a node-anchored pin does not detach: no move-comment, the anchor stays the corner', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'anchored note',
    ),
  )
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 3,
    clientX: r.left + 300,
    clientY: r.top + 100,
  })
  await new Promise((resolve) => requestAnimationFrame(resolve))
  fireEvent.pointerMove(root, { pointerId: 3, clientX: r.left + 360, clientY: r.top + 150 })
  fireEvent.pointerUp(root, { pointerId: 3, clientX: r.left + 360, clientY: r.top + 150 })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(movesOf(latest.commands)).toHaveLength(0)
  expect(commentOf(latest.canvas, 'c-node')).toMatchObject({ targetNodeId: 'n1', x: 300, y: 100 })
})
