// Resize handles around a MULTI-selection. Before this they surrounded only
// the primary node, so a selection of three offered one node's handles and
// resizing acted on that node alone — the other two just watched.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 100, text: 'a' },
    { id: 'b', type: 'text', x: 200, y: 0, width: 100, height: 100, text: 'b' },
  ],
  edges: [],
}

const A = { x: 50, y: 50 }
const B = { x: 250, y: 50 }

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
const outlineOf = (c: HTMLElement) =>
  c.querySelector('[data-testid="selection-overlay"] rect') as SVGRectElement
const nodeAt = (canvas: SpatialCanvas, id: string) => canvas.nodes.find((n) => n.id === id)

function pressAt(
  root: HTMLElement,
  p: { x: number; y: number },
  init: Record<string, unknown> = {},
) {
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + p.x,
    clientY: r.top + p.y,
    ...init,
  })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + p.x, clientY: r.top + p.y })
}

function selectBoth(root: HTMLElement) {
  pressAt(root, A)
  pressAt(root, B, { shiftKey: true })
}

it('surrounds the whole selection, not just the primary node', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  pressAt(root, A)
  expect(outlineOf(container).getAttribute('width')).toBe('100')

  pressAt(root, B, { shiftKey: true })
  const outline = outlineOf(container)
  expect(outline.getAttribute('x')).toBe('0')
  expect(outline.getAttribute('width')).toBe('300')
  expect(outline.getAttribute('height')).toBe('100')
})

it('resizes every selected node when a handle is dragged', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectBoth(root)

  const handle = container.querySelector('[data-testid="resize-handle-se"]') as SVGRectElement
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(handle, {
    button: 0,
    pointerId: 2,
    clientX: r.left + 300,
    clientY: r.top + 100,
  })
  fireEvent.pointerMove(root, { pointerId: 2, clientX: r.left + 600, clientY: r.top + 100 })
  fireEvent.pointerUp(root, { pointerId: 2, clientX: r.left + 600, clientY: r.top + 100 })

  // The union doubles in width; both members double and the gap doubles with
  // them, so the selection still fills its own handles.
  expect(nodeAt(latest.canvas, 'a')).toMatchObject({ x: 0, width: 200 })
  expect(nodeAt(latest.canvas, 'b')).toMatchObject({ x: 400, width: 200 })
})

// Connect and Edit act on ONE node. Offering them from handles that surround
// several says the action applies to all of them, which it does not.
it('offers no per-node connect or edit affordance while several are selected', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  pressAt(root, A)
  expect(container.querySelector('[data-testid="connect-handle"]')).toBeTruthy()

  pressAt(root, B, { shiftKey: true })
  expect(container.querySelector('[data-testid="connect-handle"]')).toBeNull()
  expect(container.querySelector('[data-testid="edit-handle"]')).toBeNull()
})

// The keyboard path draws from the same handles, so it has to mean the same
// thing. Resizing only the primary from handles that surround the group is
// the bug the pointer path just stopped having.
it('scales every selected node from an arrow key on a focused handle', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectBoth(root)

  const handle = container.querySelector('[data-testid="resize-handle-e"]') as SVGRectElement
  fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })

  const a = nodeAt(latest.canvas, 'a')
  const b = nodeAt(latest.canvas, 'b')
  expect(a?.width).toBeGreaterThan(100)
  expect(b?.width).toBeGreaterThan(100)
  expect(b?.x).toBeGreaterThan(200)
})

// Key repeat, and any parent that applies onChange asynchronously, both send a
// second keypress before the render snapshot has caught up. Reading the
// selection from that stale snapshot makes every press compute the same
// coordinates, so holding the key resizes once and then stops.
it('accumulates repeated keypresses even when the parent has not re-rendered', () => {
  const commands: { id: string; width: number }[] = []
  function LaggingHost() {
    // Deliberately does NOT apply the change: stands in for a parent whose
    // update lands a tick later.
    return (
      <div style={{ width: 900, height: 700 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={initial}
          onChange={(_next, command) => {
            if (command?.kind === 'resize-node') {
              commands.push({ id: command.id, width: command.width })
            }
          }}
          theme="light"
        />
      </div>
    )
  }
  const { container } = render(<LaggingHost />)
  const root = rootOf(container)
  selectBoth(root)

  const handle = container.querySelector('[data-testid="resize-handle-e"]') as SVGRectElement
  fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
  const first = commands.filter((c) => c.id === 'a').at(-1)?.width
  fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
  const second = commands.filter((c) => c.id === 'a').at(-1)?.width

  expect(first).toBeGreaterThan(100)
  expect(second).toBeGreaterThan(first as number)
})
