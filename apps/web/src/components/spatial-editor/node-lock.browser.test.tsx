// Node lock in the editor: a locked node cannot be selected, moved,
// resized, or deleted by pointer or keyboard. Lock state is HOST state
// (it lives in the Loro doc's sidecar map), so the editor takes it as a
// prop and reports toggles through a callback — the same seam shape as
// the file/image resolvers.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [
    textNode({ id: 'locked', x: 40, y: 40, width: 160, height: 80, text: 'L' }),
    textNode({ id: 'free', x: 320, y: 40, width: 160, height: 80, text: 'F' }),
  ],
  edges: [],
}

const LOCKED = ['locked']

// What the editor reports through onToggleNodeLock, which is how the host
// would learn a lock was asked for.
function toggleLog() {
  const toggles: Array<[string, boolean]> = []
  const editorProps = {
    onToggleNodeLock: (nodeId: string, locked: boolean) => {
      toggles.push([nodeId, locked])
    },
  }
  return { toggles, editorProps }
}

function pressAt(root: HTMLElement, x: number, y: number) {
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, { button: 0, pointerId: 1, clientX: r.left + x, clientY: r.top + y })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + x, clientY: r.top + y })
}

it('a locked node cannot be selected by pointer; an unlocked sibling still can', () => {
  const { Host } = makeEditorHost({ initial, lockedNodes: LOCKED })
  const { container } = render(<Host />)
  const root = rootOf(container)

  pressAt(root, 120, 80) // the locked node
  expect(container.querySelector('[data-testid="selection-overlay"]')).toBeNull()

  pressAt(root, 400, 80) // the free node
  expect(container.querySelector('[data-testid="selection-overlay"]')).not.toBeNull()
})

it('a locked node never moves: dragging over it pans nothing and marquee-select skips it', () => {
  const { Host, latest } = makeEditorHost({ initial, lockedNodes: LOCKED })
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
  const { toggles, editorProps } = toggleLog()
  const { Host } = makeEditorHost({ initial, lockedNodes: LOCKED, editorProps })
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  fireEvent.contextMenu(root, { clientX: r.left + 120, clientY: r.top + 80 })
  const unlock = [...container.querySelectorAll('[data-testid="context-menu"] button')].find(
    (el) => el.textContent === 'Unlock',
  ) as HTMLElement
  expect(unlock).toBeDefined()
  fireEvent.click(unlock)
  expect(toggles).toEqual([['locked', false]])

  fireEvent.contextMenu(root, { clientX: r.left + 400, clientY: r.top + 80 })
  const lock = [...container.querySelectorAll('[data-testid="context-menu"] button')].find(
    (el) => el.textContent === 'Lock',
  ) as HTMLElement
  expect(lock).toBeDefined()
  fireEvent.click(lock)
  expect(toggles.at(-1)).toEqual(['free', true])
})

it('a right-click on a locked node opens its menu and leaves the selection alone', () => {
  // The menu picks a locked node on purpose, so Unlock has somewhere to live.
  // Taking it as the new selection would drop the node already selected —
  // for a lock that then removes the locked one too, leaving nothing.
  const { Host } = makeEditorHost({ initial, lockedNodes: LOCKED })
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  pressAt(root, 400, 80)
  expect(container.querySelector('[data-testid="selection-overlay"]')).not.toBeNull()

  fireEvent.contextMenu(root, { clientX: r.left + 120, clientY: r.top + 80 })
  expect(container.querySelector('[data-testid="context-menu"]')).not.toBeNull()
  expect(container.querySelector('[data-testid="selection-overlay"]')).not.toBeNull()
})

it('a locked node shows no destructive or edit actions in its menu', () => {
  const { Host } = makeEditorHost({ initial, lockedNodes: LOCKED })
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
  const { toggles, editorProps } = toggleLog()
  const { Host } = makeEditorHost({ initial, lockedNodes: [], editorProps })
  const { container } = render(<Host />)
  const root = rootOf(container)

  pressAt(root, 120, 80)
  fireEvent.keyDown(root, { code: 'KeyL', key: 'l', metaKey: true, shiftKey: true })
  expect(toggles).toEqual([['locked', true]])
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
  const { toggles, editorProps } = toggleLog()
  const { Host, latest } = makeEditorHost({ initial, lockedNodes: [], editorProps })
  const { container } = render(<Host />)
  const root = rootOf(container)
  const before = latest.canvas
  pressAt(root, 120, 80)
  fireEvent.keyDown(root, { code: 'KeyL', key: 'l', metaKey: true, shiftKey: true })
  expect(latest.canvas).toBe(before)
  expect(toggles).toHaveLength(1)
})

it('a lock arriving AFTER selection drops it, so keyboard edits cannot reach the node', () => {
  const latest: { canvas: SpatialCanvas } = { canvas: initial }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    const [locked, setLocked] = useState<ReadonlySet<string>>(new Set())
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <button
          type="button"
          data-testid="remote-lock"
          onClick={() => setLocked(new Set(['free']))}
        >
          lock
        </button>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
          lockedNodeIds={locked}
          onToggleNodeLock={() => {}}
        />
      </div>
    )
  }
  const { container } = render(<Host />)
  const root = rootOf(container)

  pressAt(root, 400, 80) // select the (still free) node
  expect(container.querySelector('[data-testid="selection-overlay"]')).not.toBeNull()

  // A peer — or an agent through a wb_canvas_edit node.lock op — locks what is already selected.
  fireEvent.click(container.querySelector('[data-testid="remote-lock"]') as HTMLElement)
  expect(container.querySelector('[data-testid="selection-overlay"]')).toBeNull()

  fireEvent.keyDown(root, { key: 'Delete' })
  fireEvent.keyDown(root, { key: 'ArrowRight' })
  expect(latest.canvas.nodes.map((n) => n.id)).toEqual(['locked', 'free'])
  expect(latest.canvas.nodes.find((n) => n.id === 'free')).toMatchObject({ x: 320, y: 40 })
})

it('dragging a group leaves a locked member behind', () => {
  const grouped: SpatialCanvas = {
    nodes: [
      groupNode({ id: 'frame', x: 40, y: 40, width: 400, height: 300, label: 'G' }),
      textNode({ id: 'child-free', x: 60, y: 200, width: 100, height: 60, text: 'A' }),
      textNode({ id: 'child-locked', x: 200, y: 200, width: 100, height: 60, text: 'B' }),
    ],
    edges: [],
  }
  const { Host, latest } = makeEditorHost({ initial: grouped, lockedNodes: ['child-locked'] })
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  // Grab the frame on its own chrome (above both children) and drag it.
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 3,
    clientX: r.left + 60,
    clientY: r.top + 60,
  })
  fireEvent.pointerMove(root, { pointerId: 3, clientX: r.left + 160, clientY: r.top + 60 })
  fireEvent.pointerUp(root, { pointerId: 3, clientX: r.left + 160, clientY: r.top + 60 })

  const byId = (id: string) => latest.canvas.nodes.find((n) => n.id === id)
  expect(byId('frame')).toMatchObject({ x: 140 })
  expect(byId('child-free')).toMatchObject({ x: 160 })
  expect(byId('child-locked')).toMatchObject({ x: 200, y: 200 })
})

it('the keyboard connect overlay offers no target on a locked node', () => {
  const { Host } = makeEditorHost({ initial, lockedNodes: LOCKED })
  const { container } = render(<Host />)
  const root = rootOf(container)

  // Select the free node and start a keyboard connection from its handle.
  pressAt(root, 400, 80)
  const handle = container.querySelector('[data-testid="connect-handle"]') as HTMLElement
  handle.focus()
  fireEvent.keyDown(handle, { key: 'Enter' })

  // The pointer path already refuses a locked target; the Tab-reachable
  // buttons must agree, or the keyboard path is a way around the lock.
  expect(container.querySelector('[data-testid="connect-target-locked"]')).toBeNull()
})

it('a locked node is not offered to a marquee drag either', () => {
  const { Host, latest } = makeEditorHost({ initial, lockedNodes: LOCKED })
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
