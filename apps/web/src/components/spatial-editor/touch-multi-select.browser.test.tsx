// Building a multi-selection by touch. Shift-click is the pointer path and has
// no touch equivalent.
//
// The gesture is the iOS one: hold an item with one finger, tap others with a
// second to gather them. Long-press is deliberately NOT used — the browser
// already synthesises `contextmenu` from it, and taking it would leave touch
// with no way to reach an object's menu.
//
// A second finger otherwise means pinch, so the two are told apart by STATE,
// not by timing: only while the first finger holds a node does a second-finger
// tap gather instead of zoom.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 40, y: 40, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 300, y: 40, width: 120, height: 60, text: 'B' },
    { id: 'c', type: 'text', x: 560, y: 40, width: 120, height: 60, text: 'C' },
  ],
  edges: [],
}

/** Node centres in root-local coordinates (viewport starts at origin, zoom 1). */
const A = { x: 100, y: 70 }
const B = { x: 360, y: 70 }
const C = { x: 620, y: 70 }
const EMPTY = { x: 400, y: 400 }

function makeHost() {
  const latest = { canvas: initial }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    return (
      <div style={{ width: 900, height: 700 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => {
            latest.canvas = next
            setCanvas(next)
          }}
          theme="light"
        />
      </div>
    )
  }
  return { Host, latest }
}

const rootOf = (c: HTMLElement) => c.querySelector('[data-testid="spatial-editor"]') as HTMLElement
const memberOutlines = (c: HTMLElement) =>
  c.querySelectorAll('[data-testid="member-outlines"] rect').length
const nodeAt = (canvas: SpatialCanvas, id: string) => canvas.nodes.find((n) => n.id === id)

type Pt = { x: number; y: number }

function at(root: HTMLElement, p: Pt) {
  const r = root.getBoundingClientRect()
  return { clientX: r.left + p.x, clientY: r.top + p.y }
}
const down = (root: HTMLElement, p: Pt, pointerId: number, pointerType = 'touch') =>
  fireEvent.pointerDown(root, { button: 0, pointerId, pointerType, ...at(root, p) })
const move = (root: HTMLElement, p: Pt, pointerId: number, pointerType = 'touch') =>
  fireEvent.pointerMove(root, { pointerId, pointerType, ...at(root, p) })
const up = (root: HTMLElement, p: Pt, pointerId: number, pointerType = 'touch') =>
  fireEvent.pointerUp(root, { pointerId, pointerType, ...at(root, p) })

it('gathers a node tapped by a second finger while the first holds one', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  down(root, A, 1)
  expect(memberOutlines(container)).toBe(0)

  down(root, B, 2)
  up(root, B, 2)
  expect(memberOutlines(container)).toBe(2)

  up(root, A, 1)
  expect(memberOutlines(container)).toBe(2)
})

it('keeps gathering after the first tap, while the anchor finger stays down', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  down(root, A, 1)
  down(root, B, 2)
  up(root, B, 2)
  down(root, C, 3)
  up(root, C, 3)

  expect(memberOutlines(container)).toBe(3)
  up(root, A, 1)
})

it('drops a gathered node when it is tapped again', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  down(root, A, 1)
  down(root, B, 2)
  up(root, B, 2)
  expect(memberOutlines(container)).toBe(2)

  down(root, B, 3)
  up(root, B, 3)
  expect(memberOutlines(container)).toBe(0)

  up(root, A, 1)
})

// Gathering is a selection act, not a drag: the anchor must not carry a
// half-finished move into the new multi-selection, where every gathered node
// would jump by a delta the user never applied to it.
it('leaves the anchor where it started, even if it had begun to move', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  down(root, A, 1)
  move(root, { x: A.x + 60, y: A.y + 30 }, 1)
  down(root, B, 2)
  up(root, B, 2)
  move(root, { x: A.x + 120, y: A.y + 60 }, 1)
  up(root, { x: A.x + 120, y: A.y + 60 }, 1)

  expect(nodeAt(latest.canvas, 'a')?.x).toBe(40)
  expect(nodeAt(latest.canvas, 'a')?.y).toBe(40)
  expect(nodeAt(latest.canvas, 'b')?.x).toBe(300)
})

// A second finger on EMPTY space is the pinch the editor has always had.
it('still pinches when the second finger lands on empty space', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  const transform = () =>
    container.querySelector<HTMLDivElement>('[data-testid="viewport-transform"]')?.style.transform

  down(root, A, 1)
  const before = transform()
  down(root, EMPTY, 2)
  move(root, { x: EMPTY.x + 200, y: EMPTY.y + 200 }, 2)

  expect(memberOutlines(container)).toBe(0)
  expect(transform()).not.toBe(before)

  up(root, { x: EMPTY.x + 200, y: EMPTY.y + 200 }, 2)
  up(root, A, 1)
})

// The mouse has shift-click; a second mouse pointer is not a thing.
it('does not gather for a mouse pointer', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  down(root, A, 1, 'mouse')
  down(root, B, 2, 'mouse')
  up(root, B, 2, 'mouse')

  expect(memberOutlines(container)).toBe(0)
  up(root, A, 1, 'mouse')
})
