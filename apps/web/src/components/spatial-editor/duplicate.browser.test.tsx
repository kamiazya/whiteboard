// Duplicate (editor-completeness slice 3): Cmd/Ctrl+D and the context
// menu's Duplicate item clone the selection as ONE batch command —
// reminted ids, +16px offset, edge properties preserved, copies selected.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import type { EditorCommand } from './commands.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 40, y: 40, width: 160, height: 80, text: 'A' },
    { id: 'b', type: 'text', x: 320, y: 40, width: 160, height: 80, text: 'B' },
  ],
  edges: [
    {
      id: 'ab',
      fromNode: 'a',
      toNode: 'b',
      fromSide: 'right',
      toSide: 'left',
      label: 'kept-label',
      color: '3',
    },
  ],
}

function makeHost() {
  const latest: { canvas: SpatialCanvas; commands: EditorCommand[] } = {
    canvas: initial,
    commands: [],
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next, command) => {
            latest.commands.push(command)
            setCanvas(next)
          }}
          theme="light"
        />
      </div>
    )
  }
  return { Host, latest }
}

function selectNode(root: HTMLElement, x: number, y: number, shift = false) {
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    shiftKey: shift,
    clientX: r.left + x,
    clientY: r.top + y,
  })
  fireEvent.pointerUp(root, {
    pointerId: 1,
    shiftKey: shift,
    clientX: r.left + x,
    clientY: r.top + y,
  })
}

it('Cmd+D duplicates the selected node as ONE batch command, offset and selected', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  selectNode(root, 120, 80)

  fireEvent.keyDown(root, { code: 'KeyD', key: 'd', metaKey: true })

  expect(latest.canvas.nodes).toHaveLength(3)
  const copy = latest.canvas.nodes[2]
  expect(copy.id).not.toBe('a')
  expect(copy).toMatchObject({ type: 'text', text: 'A', x: 40 + 16, y: 40 + 16 })
  // One batch command = one undo step at the sync layer.
  const last = latest.commands.at(-1)
  expect(last?.kind).toBe('batch')
  // The copy is now the selection (duplicate-again chains).
  expect(container.querySelector('[data-testid="selection-overlay"]')).not.toBeNull()
  fireEvent.keyDown(root, { code: 'KeyD', key: 'd', ctrlKey: true })
  expect(latest.canvas.nodes).toHaveLength(4)
  expect(latest.canvas.nodes[3]).toMatchObject({ x: 40 + 32, y: 40 + 32 })
})

it('duplicating a multi-selection keeps the connecting edge WITH its properties, endpoints remapped', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  selectNode(root, 120, 80)
  selectNode(root, 400, 80, true)

  fireEvent.keyDown(root, { code: 'KeyD', key: 'd', metaKey: true })

  expect(latest.canvas.nodes).toHaveLength(4)
  expect(latest.canvas.edges).toHaveLength(2)
  const copyIds = new Set(latest.canvas.nodes.slice(2).map((n) => n.id))
  const copiedEdge = latest.canvas.edges[1]
  expect(copiedEdge.id).not.toBe('ab')
  expect(copyIds.has(copiedEdge.fromNode)).toBe(true)
  expect(copyIds.has(copiedEdge.toNode)).toBe(true)
  expect(copiedEdge).toMatchObject({
    fromSide: 'right',
    toSide: 'left',
    label: 'kept-label',
    color: '3',
  })
})

it('the context menu offers Duplicate as the touch path', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()

  fireEvent.contextMenu(root, { clientX: r.left + 120, clientY: r.top + 80 })
  const item = [...container.querySelectorAll('[data-testid="context-menu"] *')].find(
    (el) => el.textContent === 'Duplicate' && el.tagName === 'BUTTON',
  ) as HTMLElement
  expect(item).toBeDefined()
  fireEvent.click(item)
  expect(latest.canvas.nodes).toHaveLength(3)
})

it('Cmd+D without a selection does nothing (and typing d in the editor never duplicates)', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  fireEvent.keyDown(root, { code: 'KeyD', key: 'd', metaKey: true })
  expect(latest.canvas.nodes).toHaveLength(2)
  expect(latest.commands).toHaveLength(0)
})
