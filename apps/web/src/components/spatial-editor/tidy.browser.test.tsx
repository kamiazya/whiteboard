// Tidy in the editor. The geometry itself is unit-tested in tidy.test.ts;
// this pins the wiring: a multi-node selection gets a Tidy action scoped to
// the selection, empty space gets a whole-canvas one, one action is one undo
// step, and a locked node is never moved.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import type { EditorCommand } from './commands.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// 'b' sits 8px off a's column — inside the tidy band — with plenty of
// vertical clearance, so the only tidy move is b.x 48 → 40.
const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 40, y: 40, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 48, y: 200, width: 80, height: 100, text: 'B' },
  ],
  edges: [],
}

function makeHost(start: SpatialCanvas, lockedNodes: readonly string[] = []) {
  const latest: { canvas: SpatialCanvas; commands: EditorCommand[] } = {
    canvas: start,
    commands: [],
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 900, height: 700 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next, command) => {
            latest.commands.push(command)
            setCanvas(next)
          }}
          theme="light"
          lockedNodeIds={new Set(lockedNodes)}
          onToggleNodeLock={() => {}}
        />
      </div>
    )
  }
  return { Host, latest }
}

const rootOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

function selectAll(root: HTMLElement) {
  fireEvent.keyDown(root, { code: 'KeyA', key: 'a', metaKey: true })
}

function openMenuOn(root: HTMLElement, x: number, y: number) {
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + x, clientY: r.top + y })
}

const menuItem = (container: HTMLElement, label: string) =>
  [
    ...container.querySelectorAll<HTMLElement>('[data-testid="context-menu"] [role="menuitem"]'),
  ].find((el) => el.textContent?.trim() === label)

function clickItem(container: HTMLElement, label: string) {
  const button = menuItem(container, label)
  expect(button, `no menu item labelled ${label}`).toBeTruthy()
  fireEvent.click(button as HTMLElement)
}

const byId = (canvas: SpatialCanvas, id: string) => canvas.nodes.find((node) => node.id === id)!

it('tidies the selection in one undo step', () => {
  const { Host, latest } = makeHost(initial)
  const { container } = render(<Host />)
  const root = rootOf(container)

  selectAll(root)
  openMenuOn(root, 100, 70) // over node 'a', which is in the selection
  latest.commands.length = 0
  clickItem(container, 'Tidy')

  expect(byId(latest.canvas, 'a')).toMatchObject({ x: 40, y: 40 })
  expect(byId(latest.canvas, 'b')).toMatchObject({ x: 40, y: 200 })
  // One batch, not one move per node: a tidy is one user action.
  expect(latest.commands).toHaveLength(1)
  expect(latest.commands[0]).toMatchObject({ kind: 'batch' })
})

it('offers no Tidy for a single-node selection', () => {
  const { Host } = makeHost(initial)
  const { container } = render(<Host />)
  const root = rootOf(container)

  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 100,
    clientY: r.top + 70,
  })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 100, clientY: r.top + 70 })
  openMenuOn(root, 100, 70)

  expect(menuItem(container, 'Tidy')).toBeUndefined()
})

it('never moves a locked node — it stands as a fixed obstacle', () => {
  // 'c' is locked and 12px off the column; select-all skips it, and tidy
  // must leave it exactly where it was while still fixing 'b'.
  const withLocked: SpatialCanvas = {
    nodes: [
      ...initial.nodes,
      { id: 'c', type: 'text', x: 52, y: 400, width: 60, height: 40, text: 'C' },
    ],
    edges: [],
  }
  const { Host, latest } = makeHost(withLocked, ['c'])
  const { container } = render(<Host />)
  const root = rootOf(container)

  selectAll(root)
  openMenuOn(root, 100, 70)
  clickItem(container, 'Tidy')

  expect(byId(latest.canvas, 'b').x).toBe(40)
  expect(byId(latest.canvas, 'c')).toMatchObject({ x: 52, y: 400 })
})

it('tidies the whole canvas from the empty-space menu', () => {
  const { Host, latest } = makeHost(initial)
  const { container } = render(<Host />)
  const root = rootOf(container)

  openMenuOn(root, 600, 500) // empty space, nothing selected
  latest.commands.length = 0
  clickItem(container, 'Tidy canvas')

  expect(byId(latest.canvas, 'b').x).toBe(40)
  expect(latest.commands).toHaveLength(1)
  expect(latest.commands[0]).toMatchObject({ kind: 'batch' })
})

it('emits nothing when the canvas is already tidy', () => {
  const { Host, latest } = makeHost(initial)
  const { container } = render(<Host />)
  const root = rootOf(container)

  openMenuOn(root, 600, 500)
  clickItem(container, 'Tidy canvas')
  latest.commands.length = 0

  openMenuOn(root, 600, 500)
  clickItem(container, 'Tidy canvas')
  // Already a fixpoint: no second undo step to step back through.
  expect(latest.commands).toHaveLength(0)
})
