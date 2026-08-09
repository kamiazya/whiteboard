// Node lock in the editor: a locked node cannot be selected, moved,
// resized, or deleted by pointer or keyboard. Lock state is HOST state
// (it lives in the Loro doc's sidecar map), so the editor takes it as a
// prop and reports toggles through a callback — the same seam shape as
// the file/image resolvers.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [
    { id: 'locked', type: 'text', x: 40, y: 40, width: 160, height: 80, text: 'L' },
    { id: 'free', type: 'text', x: 320, y: 40, width: 160, height: 80, text: 'F' },
  ],
  edges: [],
}

function makeHost(lockedIds: readonly string[] = ['locked']) {
  const latest: { canvas: SpatialCanvas; toggles: Array<[string, boolean]> } = {
    canvas: initial,
    toggles: [],
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
          lockedNodeIds={new Set(lockedIds)}
          onToggleNodeLock={(nodeId, locked) => latest.toggles.push([nodeId, locked])}
        />
      </div>
    )
  }
  return { Host, latest }
}

const rootOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

function pressAt(root: HTMLElement, x: number, y: number) {
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, { button: 0, pointerId: 1, clientX: r.left + x, clientY: r.top + y })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + x, clientY: r.top + y })
}

it('a locked node cannot be selected by pointer; an unlocked sibling still can', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  pressAt(root, 120, 80) // the locked node
  expect(container.querySelector('[data-testid="selection-overlay"]')).toBeNull()

  pressAt(root, 400, 80) // the free node
  expect(container.querySelector('[data-testid="selection-overlay"]')).not.toBeNull()
})

it('a locked node never moves: dragging over it pans nothing and marquee-select skips it', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  // Drag starting on the locked node must not move it.
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 120,
    clientY: r.top + 80,
  })
  fireEvent.pointerMove(root, { pointerId: 1, clientX: r.left + 260, clientY: r.top + 200 })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 260, clientY: r.top + 200 })
  expect(latest.canvas.nodes.find((n) => n.id === 'locked')).toMatchObject({ x: 40, y: 40 })

  // A marquee across everything selects only the unlocked node, so a
  // following Delete cannot take the locked one with it.
  fireEvent.keyDown(root, { code: 'KeyA', key: 'a', metaKey: true })
  fireEvent.keyDown(root, { key: 'Delete' })
  expect(latest.canvas.nodes.map((n) => n.id)).toEqual(['locked'])
})

it('the context menu offers Unlock on a locked node, and Lock on a free one', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  fireEvent.contextMenu(root, { clientX: r.left + 120, clientY: r.top + 80 })
  const unlock = [...container.querySelectorAll('[data-testid="context-menu"] button')].find(
    (el) => el.textContent === 'Unlock',
  ) as HTMLElement
  expect(unlock).toBeDefined()
  fireEvent.click(unlock)
  expect(latest.toggles).toEqual([['locked', false]])

  fireEvent.contextMenu(root, { clientX: r.left + 400, clientY: r.top + 80 })
  const lock = [...container.querySelectorAll('[data-testid="context-menu"] button')].find(
    (el) => el.textContent === 'Lock',
  ) as HTMLElement
  expect(lock).toBeDefined()
  fireEvent.click(lock)
  expect(latest.toggles.at(-1)).toEqual(['free', true])
})

it('a locked node shows no destructive or edit actions in its menu', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  fireEvent.contextMenu(root, { clientX: r.left + 120, clientY: r.top + 80 })
  const labels = [...container.querySelectorAll('[data-testid="context-menu"] button')].map(
    (el) => el.textContent,
  )
  expect(labels).toContain('Unlock')
  for (const forbidden of ['Delete', 'Edit text', 'Duplicate', 'Cut']) {
    expect(labels).not.toContain(forbidden)
  }
})

it('Cmd+Shift+L toggles the lock on the current selection', () => {
  const { Host, latest } = makeHost([])
  const { container } = render(<Host />)
  const root = rootOf(container)

  pressAt(root, 120, 80)
  fireEvent.keyDown(root, { code: 'KeyL', key: 'l', metaKey: true, shiftKey: true })
  expect(latest.toggles).toEqual([['locked', true]])
})

it('without the host seam the lock is inert — no menu entry, nothing blocked', () => {
  function Bare() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
        />
      </div>
    )
  }
  const { container } = render(<Bare />)
  const root = rootOf(container)
  pressAt(root, 120, 80)
  expect(container.querySelector('[data-testid="selection-overlay"]')).not.toBeNull()

  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 120, clientY: r.top + 80 })
  const labels = [...container.querySelectorAll('[data-testid="context-menu"] button')].map(
    (el) => el.textContent,
  )
  expect(labels).not.toContain('Lock')
  expect(labels).not.toContain('Unlock')
})

it('reports the toggle without mutating the canvas itself (lock is not canvas content)', () => {
  const { Host, latest } = makeHost([])
  const { container } = render(<Host />)
  const root = rootOf(container)
  const before = latest.canvas
  pressAt(root, 120, 80)
  fireEvent.keyDown(root, { code: 'KeyL', key: 'l', metaKey: true, shiftKey: true })
  expect(latest.canvas).toBe(before)
  expect(latest.toggles).toHaveLength(1)
})

it('a locked node is not offered to a marquee drag either', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  const onChange = vi.fn()
  void onChange

  // Marquee from empty space across BOTH nodes.
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 2,
    clientX: r.left + 10,
    clientY: r.top + 10,
  })
  fireEvent.pointerMove(root, { pointerId: 2, clientX: r.left + 700, clientY: r.top + 400 })
  fireEvent.pointerUp(root, { pointerId: 2, clientX: r.left + 700, clientY: r.top + 400 })

  fireEvent.keyDown(root, { key: 'Delete' })
  expect(latest.canvas.nodes.map((n) => n.id)).toEqual(['locked'])
})
