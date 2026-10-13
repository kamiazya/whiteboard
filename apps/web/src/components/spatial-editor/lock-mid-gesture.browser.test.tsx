// A lock that arrives from a peer or an agent while a person is already
// mid-gesture on the target. Hit-test filtering cannot stop this — the
// gesture began before the lock existed — so the editor has to retire the
// gesture (or the open label editor) when the lock prop changes. Without
// that, releasing the pointer commits a move or resize of a locked node.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { edgeMidpoint, rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 100, y: 100, width: 120, height: 60, text: 'A' }),
    textNode({ id: 'b', x: 400, y: 100, width: 120, height: 60, text: 'B' }),
    textNode({ id: 'c', x: 400, y: 400, width: 120, height: 60, text: 'C' }),
  ],
  edges: [
    { id: 'e1', from: { node: 'a' }, to: { node: 'b' } },
    { id: 'e2', from: { node: 'b' }, to: { node: 'c' } },
  ],
}

const frame = () => new Promise((r) => requestAnimationFrame(r))

/**
 * Lock props whose set can be replaced from outside. The shared host spreads
 * `editorProps` on every render, so the getters hand the editor a NEW set on
 * the next rerender — the shape a peer's lock arrives in — while the canvas
 * state and the in-flight gesture live on.
 */
function remoteLocks() {
  let nodes: ReadonlySet<string> = new Set()
  let edges: ReadonlySet<string> = new Set()
  const editorProps = {
    get lockedNodeIds() {
      return nodes
    },
    get lockedEdgeIds() {
      return edges
    },
    onToggleNodeLock: () => {},
    onToggleEdgeLock: () => {},
  }
  return {
    editorProps,
    lockNode: (id: string) => {
      nodes = new Set([...nodes, id])
    },
    lockEdge: (id: string) => {
      edges = new Set([...edges, id])
    },
  }
}

it('a node locked mid-drag stays where it was when the pointer is released', () => {
  const locks = remoteLocks()
  const { Host, latest } = makeEditorHost({ initial, editorProps: locks.editorProps })
  const { container, rerender } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 160,
    clientY: r.top + 130,
  })
  fireEvent.pointerMove(root, { pointerId: 1, clientX: r.left + 220, clientY: r.top + 190 })

  locks.lockNode('a')
  rerender(<Host />)

  fireEvent.pointerMove(root, { pointerId: 1, clientX: r.left + 260, clientY: r.top + 230 })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 260, clientY: r.top + 230 })
  expect(latest.canvas.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 100, y: 100 })
  expect(latest.kinds).not.toContain('move-nodes')
})

it('a node locked mid-resize keeps its size when the pointer is released', async () => {
  const locks = remoteLocks()
  const { Host, latest } = makeEditorHost({ initial, editorProps: locks.editorProps })
  const { container, rerender } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  // Select a, then grab its east handle and pull it right without releasing.
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 4,
    clientX: r.left + 160,
    clientY: r.top + 130,
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
    clientX: r.left + 300,
    clientY: r.top + 130,
    buttons: 1,
  })
  await frame()

  locks.lockNode('a')
  rerender(<Host />)

  fireEvent.pointerMove(root, {
    pointerId: 5,
    clientX: r.left + 320,
    clientY: r.top + 130,
    buttons: 1,
  })
  fireEvent.pointerUp(root, { pointerId: 5, clientX: r.left + 320, clientY: r.top + 130 })
  await frame()
  expect(latest.canvas.nodes.find((n) => n.id === 'a')).toMatchObject({
    x: 100,
    y: 100,
    width: 120,
    height: 60,
  })
})

it('locking an edge closes its open label editor, and only its own', async () => {
  const locks = remoteLocks()
  const { Host } = makeEditorHost({ initial, editorProps: locks.editorProps })
  const { container, rerender } = render(<Host />)
  const editor = () => container.querySelector('[data-testid="edge-label-editor"]')

  await userEvent.dblClick(rootOf(container), { position: edgeMidpoint(container) })
  await vi.waitFor(() => expect(editor()).not.toBeNull())

  // A lock on some other edge leaves the open editor alone.
  locks.lockEdge('e2')
  rerender(<Host />)
  await frame()
  expect(editor()).not.toBeNull()

  locks.lockEdge('e1')
  rerender(<Host />)
  await vi.waitFor(() => expect(editor()).toBeNull())
})
