// A drag that starts on a frame's empty interior sweeps a band, the way it
// does on the bare canvas; the frame itself is carried from its border band.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const framed: SpatialCanvas = {
  nodes: [
    groupNode({ id: 'g1', x: 80, y: 80, width: 360, height: 220, label: 'cluster' }),
    textNode({ id: 'a', x: 120, y: 120, width: 120, height: 60, text: 'A' }),
    textNode({ id: 'b', x: 280, y: 200, width: 120, height: 60, text: 'B' }),
  ],
  edges: [],
}

function dragFrom(root: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }) {
  const r = root.getBoundingClientRect()
  const at = (p: { x: number; y: number }) => ({
    pointerId: 1,
    clientX: r.left + p.x,
    clientY: r.top + p.y,
    buttons: 1,
  })
  fireEvent.pointerDown(root, { ...at(from), button: 0 })
  fireEvent.pointerMove(root, at({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }))
  fireEvent.pointerMove(root, at(to))
  fireEvent.pointerUp(root, at(to))
}

const frameOf = (latest: { canvas: SpatialCanvas }) =>
  latest.canvas.nodes.find((n) => n.id === 'g1')

it('a drag from the frame interior selects what it sweeps and leaves the frame in place', async () => {
  const { Host, latest } = makeEditorHost({ initial: framed })
  const { container } = render(<Host />)

  dragFrom(rootOf(container), { x: 100, y: 270 }, { x: 350, y: 150 })

  await vi.waitFor(() => {
    expect(container.querySelectorAll('[data-testid="member-outlines"] rect').length).toBe(2)
  })
  expect(frameOf(latest)).toMatchObject({ x: 80, y: 80 })
  expect(latest.kinds).not.toContain('move-node')
})

it('a drag from the frame border still carries the frame and its members', async () => {
  const { Host, latest } = makeEditorHost({ initial: framed })
  const { container } = render(<Host />)

  dragFrom(rootOf(container), { x: 82, y: 150 }, { x: 142, y: 190 })

  await vi.waitFor(() => expect(frameOf(latest)).toMatchObject({ x: 140, y: 120 }))
  expect(latest.canvas.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 180, y: 160 })
})
