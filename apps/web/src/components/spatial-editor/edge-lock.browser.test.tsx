// Edge lock in the editor. An edge is its own object, so it locks on its
// own — a locked endpoint does not freeze the lines touching it, and an
// edge between two free nodes is still lockable. Same host-state seam as
// the node lock: the editor takes the set as a prop and reports toggles
// through a callback.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 40, y: 40, width: 160, height: 80, text: 'A' },
    { id: 'b', type: 'text', x: 360, y: 40, width: 160, height: 80, text: 'B' },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
}

// The edge runs between the two boxes, so its line crosses this point.
const ON_EDGE: readonly [number, number] = [280, 80]

function makeHost(lockedEdges: readonly string[] = ['e1'], lockedNodes: readonly string[] = []) {
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
          lockedNodeIds={new Set(lockedNodes)}
          onToggleNodeLock={() => {}}
          lockedEdgeIds={new Set(lockedEdges)}
          onToggleEdgeLock={(edgeId, locked) => latest.toggles.push([edgeId, locked])}
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

function menuLabels(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('[data-testid="context-menu"] button')].map(
    (el) => el.textContent,
  )
}

it('a locked edge cannot be selected by pointer, so Delete cannot reach it', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  pressAt(root, ...ON_EDGE)
  fireEvent.keyDown(root, { key: 'Delete' })
  expect(latest.canvas.edges.map((edge) => edge.id)).toEqual(['e1'])
})

it('an unlocked edge is still selectable and deletable', () => {
  const { Host, latest } = makeHost([])
  const { container } = render(<Host />)
  const root = rootOf(container)

  pressAt(root, ...ON_EDGE)
  fireEvent.keyDown(root, { key: 'Delete' })
  expect(latest.canvas.edges).toEqual([])
})

it('a locked endpoint does NOT freeze the edge — edge locks are their own set', () => {
  // 'a' is locked, the edge is not: the line stays editable, which is the
  // whole reason edge locks are stored rather than derived.
  const { Host, latest } = makeHost([], ['a'])
  const { container } = render(<Host />)
  const root = rootOf(container)

  pressAt(root, ...ON_EDGE)
  fireEvent.keyDown(root, { key: 'Delete' })
  expect(latest.canvas.edges).toEqual([])
})

it('the context menu offers Unlock on a locked edge, and Lock on a free one', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  fireEvent.contextMenu(root, { clientX: r.left + ON_EDGE[0], clientY: r.top + ON_EDGE[1] })
  const unlock = [...container.querySelectorAll('[data-testid="context-menu"] button')].find(
    (el) => el.textContent === 'Unlock',
  ) as HTMLElement
  expect(unlock).toBeDefined()
  fireEvent.click(unlock)
  expect(latest.toggles).toEqual([['e1', false]])
})

it('a locked edge shows no destructive or restyling actions in its menu', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  fireEvent.contextMenu(root, { clientX: r.left + ON_EDGE[0], clientY: r.top + ON_EDGE[1] })
  const labels = menuLabels(container)
  expect(labels).toContain('Unlock')
  for (const forbidden of ['Delete', 'Edit label']) {
    expect(labels).not.toContain(forbidden)
  }
})

it('a free edge gains a Lock entry', () => {
  const { Host, latest } = makeHost([])
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()

  fireEvent.contextMenu(root, { clientX: r.left + ON_EDGE[0], clientY: r.top + ON_EDGE[1] })
  const lock = [...container.querySelectorAll('[data-testid="context-menu"] button')].find(
    (el) => el.textContent === 'Lock',
  ) as HTMLElement
  expect(lock).toBeDefined()
  fireEvent.click(lock)
  expect(latest.toggles).toEqual([['e1', true]])
})

it('Cmd+Shift+L toggles the lock on a selected edge', () => {
  const { Host, latest } = makeHost([])
  const { container } = render(<Host />)
  const root = rootOf(container)

  pressAt(root, ...ON_EDGE)
  fireEvent.keyDown(root, { code: 'KeyL', key: 'l', metaKey: true, shiftKey: true })
  expect(latest.toggles).toEqual([['e1', true]])
})

it('a lock arriving AFTER selection drops it, so Delete cannot reach the edge', () => {
  const latest: { canvas: SpatialCanvas } = { canvas: initial }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    const [locked, setLocked] = useState<ReadonlySet<string>>(new Set())
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <button type="button" data-testid="remote-lock" onClick={() => setLocked(new Set(['e1']))}>
          lock
        </button>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
          lockedEdgeIds={locked}
          onToggleEdgeLock={() => {}}
        />
      </div>
    )
  }
  const { container } = render(<Host />)
  const root = rootOf(container)

  pressAt(root, ...ON_EDGE)
  fireEvent.click(container.querySelector('[data-testid="remote-lock"]') as HTMLElement)
  fireEvent.keyDown(root, { key: 'Delete' })
  expect(latest.canvas.edges.map((edge) => edge.id)).toEqual(['e1'])
})

it('without the host seam the edge lock is inert — no menu entry, nothing blocked', () => {
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
  const r = root.getBoundingClientRect()

  fireEvent.contextMenu(root, { clientX: r.left + ON_EDGE[0], clientY: r.top + ON_EDGE[1] })
  const labels = menuLabels(container)
  expect(labels).not.toContain('Lock')
  expect(labels).not.toContain('Unlock')
})
