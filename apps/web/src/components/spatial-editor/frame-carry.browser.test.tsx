// A frame carries what it holds — the same geometric rule a pointer drag on
// its border already used — whichever way the person moves it.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { selectAt } from '../../test-utils/spatial-editor-pointer.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const grouped: SpatialCanvas = {
  nodes: [
    groupNode({ id: 'g1', x: 80, y: 80, width: 360, height: 220, label: 'cluster' }),
    textNode({ id: 'a', x: 120, y: 120, width: 120, height: 60, text: 'A' }),
    textNode({ id: 'b', x: 280, y: 200, width: 120, height: 60, text: 'B' }),
    textNode({ id: 'c', x: 600, y: 400, width: 120, height: 60, text: 'C' }),
  ],
  edges: [],
}

function boxOf(latest: { canvas: SpatialCanvas }, id: string) {
  const node = latest.canvas.nodes.find((n) => n.id === id)
  if (node === undefined) throw new Error(`node ${id} missing`)
  return { x: node.x, y: node.y }
}

it('an arrow-key nudge on a frame carries its members in one batch', () => {
  const { Host, latest } = makeEditorHost({ initial: grouped })
  const { container } = render(<Host />)
  const root = rootOf(container)
  // The border band resolves to the frame itself.
  selectAt(root, 82, 200)

  const commandsBefore = latest.commands.length
  fireEvent.keyDown(root, { key: 'ArrowDown', shiftKey: true })

  expect(latest.commands.length).toBe(commandsBefore + 1)
  expect(latest.commands.at(-1)?.kind).toBe('batch')
  expect(boxOf(latest, 'g1')).toEqual({ x: 80, y: 112 })
  expect(boxOf(latest, 'a')).toEqual({ x: 120, y: 152 })
  expect(boxOf(latest, 'b')).toEqual({ x: 280, y: 232 })
  expect(boxOf(latest, 'c')).toEqual({ x: 600, y: 400 })
})

it('a frame nudge leaves a locked member where it is', () => {
  const { Host, latest } = makeEditorHost({ initial: grouped, lockedNodes: ['b'] })
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 82, 200)

  fireEvent.keyDown(root, { key: 'ArrowRight' })

  expect(boxOf(latest, 'g1')).toEqual({ x: 88, y: 80 })
  expect(boxOf(latest, 'a')).toEqual({ x: 128, y: 120 })
  expect(boxOf(latest, 'b')).toEqual({ x: 280, y: 200 })
})

it('dragging a selection that includes a frame carries the frame members', () => {
  const { Host, latest } = makeEditorHost({ initial: grouped })
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 660, 430)
  selectAt(root, 82, 200, true)

  fireEvent.pointerDown(root, { pointerId: 1, clientX: 660, clientY: 430, buttons: 1 })
  fireEvent.pointerMove(root, { pointerId: 1, clientX: 700, clientY: 470, buttons: 1 })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: 700, clientY: 470 })

  expect(boxOf(latest, 'c')).toEqual({ x: 640, y: 440 })
  expect(boxOf(latest, 'g1')).toEqual({ x: 120, y: 120 })
  expect(boxOf(latest, 'a')).toEqual({ x: 160, y: 160 })
})

it('dragging a frame by its name strip carries the frame and its members', () => {
  const { Host, latest } = makeEditorHost({ initial: grouped })
  const { container } = render(<Host />)
  const root = rootOf(container)

  // The name is drawn in the band above the frame's top edge.
  fireEvent.pointerDown(root, { pointerId: 1, clientX: 200, clientY: 60, buttons: 1 })
  fireEvent.pointerMove(root, { pointerId: 1, clientX: 240, clientY: 100, buttons: 1 })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: 240, clientY: 100 })

  expect(boxOf(latest, 'g1')).toEqual({ x: 120, y: 120 })
  expect(boxOf(latest, 'a')).toEqual({ x: 160, y: 160 })
  expect(boxOf(latest, 'c')).toEqual({ x: 600, y: 400 })
})

it('a selected frame resizes from a press 8px outside its corner', () => {
  const { Host, latest } = makeEditorHost({ initial: grouped })
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 82, 200)

  // Delivered to whatever the browser's own hit test finds there, so this
  // asserts the size of the corner's hit area, not the handler.
  const r = root.getBoundingClientRect()
  const target = document.elementFromPoint(r.left + 448, r.top + 308)
  if (target === null) throw new Error('nothing under the corner')
  fireEvent.pointerDown(target, {
    button: 0,
    pointerId: 2,
    clientX: r.left + 448,
    clientY: r.top + 308,
  })
  fireEvent.pointerMove(root, { pointerId: 2, clientX: r.left + 488, clientY: r.top + 348 })
  fireEvent.pointerUp(root, { pointerId: 2, clientX: r.left + 488, clientY: r.top + 348 })

  const frame = latest.canvas.nodes.find((n) => n.id === 'g1')
  expect(frame?.width).toBeGreaterThan(360)
  expect(frame?.height).toBeGreaterThan(220)
})
