// ADR-0025: a comment's pin is draggable, and where it lands is what it is
// about — a node, an edge, or the point (owner decision, 2026-11-07). Each
// drop commits one `move-thread`. Real browser: the pin is hit-tested
// against the laid-out scene, which only exists once the editor has rendered.

import type { CanvasComment } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import { type CommentBoard, makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

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
const start: CommentBoard = {
  nodes: [
    textNode({ id: 'n1', x: 100, y: 100, width: 200, height: 100, text: 'hello' }),
    textNode({ id: 'n2', x: 350, y: 250, width: 150, height: 80, text: 'other' }),
  ],
  edges: [],
  comments: [ANCHORED, FREE],
}

function commentOf(comments: readonly CanvasComment[], id: string): CanvasComment | undefined {
  return comments.find((c) => c.id === id)
}

function movesOf(commands: readonly EditorCommand[]) {
  return commands.filter((c) => c.kind === 'move-thread')
}

it('dragging a point-anchored pin moves the anchor and commits one move-thread', async () => {
  const { Host, latest } = makeEditorHost({ initial: start })
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
    kind: 'move-thread',
    threadId: 'c-free',
    x: 660,
    y: 500,
  })
  expect(commentOf(latest.comments, 'c-free')).toMatchObject({ x: 660, y: 500, text: 'free note' })
  expect(container.querySelector('[data-testid="comment-drag-preview"]')).toBeNull()
  // The press selected nothing and created nothing.
  expect(latest.canvas.nodes).toHaveLength(2)
})

it('a pressed pin stays on screen before the pointer has moved', async () => {
  const { Host } = makeEditorHost({ initial: start })
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
    pointerId: 7,
    clientX: r.left + 600,
    clientY: r.top + 450,
  })
  await new Promise((resolve) => requestAnimationFrame(resolve))

  // The press alone starts the drag, which takes the committed copy out of
  // the surface. The preview only rendered once a pointer MOVE supplied a
  // live point, so between the two the comment was in neither place and
  // simply vanished — most visibly on touch, where a long-press commits the
  // drag and a finger held still supplies no move at all.
  expect(root.textContent).toContain('free note')
})

it('a press on a pin that does not travel is not a move', async () => {
  const { Host, latest } = makeEditorHost({ initial: start })
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
  expect(commentOf(latest.comments, 'c-free')).toMatchObject({ x: 600, y: 450 })
})

it('a pointercancel mid-drag writes nothing, and the torn-down drag cannot commit on a later release', async () => {
  const { Host, latest } = makeEditorHost({ initial: start })
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
  expect(commentOf(latest.comments, 'c-free')).toMatchObject({ x: 600, y: 450 })
})

async function dragPin(
  container: HTMLElement,
  pointerId: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId,
    clientX: r.left + from.x,
    clientY: r.top + from.y,
  })
  await new Promise((resolve) => requestAnimationFrame(resolve))
  fireEvent.pointerMove(root, { pointerId, clientX: r.left + to.x, clientY: r.top + to.y })
  fireEvent.pointerUp(root, { pointerId, clientX: r.left + to.x, clientY: r.top + to.y })
}

async function rendered(container: HTMLElement) {
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'anchored note',
    ),
  )
}

it('a node pin let go on empty canvas is carried off its node and becomes a point', async () => {
  const { Host, latest } = makeEditorHost({ initial: start })
  const { container } = render(<Host />)
  await rendered(container)
  // The pin is drawn at the node's top-right corner, so that is where it is pressed.
  await dragPin(container, 3, { x: 300, y: 100 }, { x: 560, y: 160 })
  await vi.waitFor(() => expect(movesOf(latest.commands)).toHaveLength(1))
  expect(movesOf(latest.commands)[0]).toEqual({
    kind: 'move-thread',
    threadId: 'c-node',
    x: 560,
    y: 160,
  })
  const moved = commentOf(latest.comments, 'c-node')
  expect(moved).toMatchObject({ x: 560, y: 160 })
  expect(moved?.targetNodeId).toBeUndefined()
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="comment-drag-preview"]')).toBeNull(),
  )
})

it('a pin dropped on a node is about that node, and settles at its corner', async () => {
  const { Host, latest } = makeEditorHost({ initial: start })
  const { container } = render(<Host />)
  await rendered(container)
  await dragPin(container, 6, { x: 600, y: 450 }, { x: 200, y: 150 })
  await vi.waitFor(() => expect(movesOf(latest.commands)).toHaveLength(1))
  expect(movesOf(latest.commands)[0]).toEqual({
    kind: 'move-thread',
    threadId: 'c-free',
    x: 200,
    y: 150,
    nodeId: 'n1',
  })
  expect(commentOf(latest.comments, 'c-free')).toMatchObject({ targetNodeId: 'n1' })
  // The preview parks on the corner the layer draws the pin at, so it gives
  // way to the committed copy rather than waiting on a drop point the pin
  // never stands on.
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="comment-drag-preview"]')).toBeNull(),
  )
})

it('a node pin dropped on another node moves to it', async () => {
  const { Host, latest } = makeEditorHost({ initial: start })
  const { container } = render(<Host />)
  await rendered(container)
  await dragPin(container, 8, { x: 300, y: 100 }, { x: 420, y: 290 })
  await vi.waitFor(() => expect(movesOf(latest.commands)).toHaveLength(1))
  expect(movesOf(latest.commands)[0]).toMatchObject({ threadId: 'c-node', nodeId: 'n2' })
  expect(commentOf(latest.comments, 'c-node')).toMatchObject({ targetNodeId: 'n2' })
})

it('a pin settles on a node whose corner is not a whole pixel', async () => {
  // The pin's box is laid out around its anchor and read back by the settle
  // check; at y = 0.1 that round trip is not exact in floating point.
  const { Host, latest } = makeEditorHost({
    initial: {
      ...start,
      nodes: [
        ...start.nodes,
        textNode({ id: 'top', x: 600, y: 0.1, width: 100, height: 80, text: 'top' }),
      ],
    },
  })
  const { container } = render(<Host />)
  await rendered(container)
  await dragPin(container, 10, { x: 600, y: 450 }, { x: 650, y: 40 })
  await vi.waitFor(() => expect(movesOf(latest.commands)).toHaveLength(1))
  expect(movesOf(latest.commands)[0]).toMatchObject({ threadId: 'c-free', nodeId: 'top' })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="comment-drag-preview"]')).toBeNull(),
  )
})

it('a pin dropped on an edge rides that edge', async () => {
  const { Host, latest } = makeEditorHost({
    initial: {
      ...start,
      nodes: [
        ...start.nodes,
        textNode({ id: 'a', x: 100, y: 600, width: 100, height: 60, text: 'a' }),
        textNode({ id: 'b', x: 400, y: 600, width: 100, height: 60, text: 'b' }),
      ],
      edges: [{ id: 'e1', from: { node: 'a', side: 'right' }, to: { node: 'b', side: 'left' } }],
    },
  })
  const { container } = render(<Host />)
  await rendered(container)
  // Two boxes side by side: the edge runs straight along y=630.
  await dragPin(container, 9, { x: 600, y: 450 }, { x: 300, y: 630 })
  await vi.waitFor(() => expect(movesOf(latest.commands)).toHaveLength(1))
  expect(movesOf(latest.commands)[0]).toMatchObject({ threadId: 'c-free', edgeId: 'e1' })
  expect(commentOf(latest.comments, 'c-free')).toMatchObject({ targetEdgeId: 'e1' })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="comment-drag-preview"]')).toBeNull(),
  )
})

// Twelve or more elements send layout to the worker, so the committed scene
// arrives a round trip AFTER the drop — the case that showed the jank: the
// preview vanished, the committed group came back at the OLD anchor, and the
// keyed patcher's FLIP then animated it to the new one.
const FILLER = Array.from({ length: 12 }, (_, i) =>
  textNode({
    id: `f${i}`,
    x: 20 + (i % 4) * 60,
    y: 520 + Math.floor(i / 4) * 30,
    width: 50,
    height: 24,
    text: `${i}`,
  }),
)

it('a drop lands the comment at the new anchor with no flight back from the old one', async () => {
  const { Host, latest } = makeEditorHost({
    initial: { ...start, nodes: [...start.nodes, ...FILLER] },
  })
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="canvas-content"]')?.textContent).toContain(
      'free note',
    ),
  )
  const committed = () =>
    container.querySelector(
      '[data-testid="canvas-content"] [data-wb-key="c-free/bubble"]',
    ) as SVGGElement | null

  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 5,
    clientX: r.left + 600,
    clientY: r.top + 450,
  })
  await new Promise((resolve) => requestAnimationFrame(resolve))
  fireEvent.pointerMove(root, { pointerId: 5, clientX: r.left + 660, clientY: r.top + 500 })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="comment-drag-preview"]')).not.toBeNull(),
  )
  // While the preview is up the committed copy is not in the document at
  // all (hidden is not enough: a hidden group still gets REPLACED on the
  // drop, and a replaced group is what the patcher animates).
  expect(committed()).toBeNull()

  fireEvent.pointerUp(root, { pointerId: 5, clientX: r.left + 660, clientY: r.top + 500 })
  await vi.waitFor(() => expect(movesOf(latest.commands)).toHaveLength(1))
  // The preview outlives the drop until the committed scene has the comment
  // at its NEW anchor, and that arrival is an insertion: never animated.
  // The first worker reply also waits for the worker's font to load.
  await vi.waitFor(() => expect(committed()).not.toBeNull(), { timeout: 10_000 })
  const group = committed() as SVGGElement
  expect(group.getAnimations()).toHaveLength(0)
  const rect = group.querySelector('rect') as SVGRectElement
  expect(Number.parseFloat(rect.getAttribute('x') ?? 'NaN')).toBeGreaterThan(660)
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="comment-drag-preview"]')).toBeNull(),
  )
}, 20_000)
