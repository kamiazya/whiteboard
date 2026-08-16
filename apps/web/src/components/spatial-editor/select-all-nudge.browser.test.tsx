// Select-all (Cmd/Ctrl+A) + multi-selection nudge parity (editor-
// completeness slice 6). The nudge fix closes a latent bug select-all
// makes immediately visible: arrow keys moved only the PRIMARY node,
// tearing a multi-selection apart.
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
    { id: 'c', type: 'text', x: 40, y: 240, width: 160, height: 80, text: 'C' },
  ],
  edges: [],
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

const rootOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

function selectAt(root: HTMLElement, x: number, y: number, shift = false) {
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

it('Cmd/Ctrl+A selects every node; Delete then removes them all', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  fireEvent.keyDown(root, { code: 'KeyA', key: 'a', metaKey: true })
  expect(container.querySelector('[data-testid="selection-overlay"]')).not.toBeNull()

  fireEvent.keyDown(root, { key: 'Delete' })
  expect(latest.canvas.nodes).toEqual([])
})

it('arrow-key nudge moves the WHOLE multi-selection by the same delta', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)
  selectAt(root, 400, 80, true)

  const commandsBefore = latest.commands.length
  fireEvent.keyDown(root, { key: 'ArrowRight' })
  // ONE batch command, not one per node: the whole nudge is one undo step.
  expect(latest.commands.length).toBe(commandsBefore + 1)
  expect(latest.commands.at(-1)?.kind).toBe('batch')
  const a = latest.canvas.nodes.find((n) => n.id === 'a')
  const b = latest.canvas.nodes.find((n) => n.id === 'b')
  const c = latest.canvas.nodes.find((n) => n.id === 'c')
  expect(a?.x).toBeGreaterThan(40)
  expect(b?.x ?? 0).toBe(320 + ((a?.x ?? 0) - 40))
  // The unselected node never moves.
  expect(c).toMatchObject({ x: 40, y: 240 })
})

it('Cmd+A always consumes the event, so the browser never runs its own select-all', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  const withNodes = fireEvent.keyDown(root, { code: 'KeyA', key: 'a', metaKey: true })
  // fireEvent returns false when preventDefault() was called.
  expect(withNodes).toBe(false)
})

it('Cmd+A on an empty canvas selects nothing but still consumes the event', () => {
  const empty: SpatialCanvas = { nodes: [], edges: [] }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(empty)
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
  const { container } = render(<Host />)
  const consumed = fireEvent.keyDown(rootOf(container), { code: 'KeyA', key: 'a', metaKey: true })
  expect(container.querySelector('[data-testid="selection-overlay"]')).toBeNull()
  // Native select-all would highlight the whole page — a handled no-op
  // still has to swallow the chord.
  expect(consumed).toBe(false)
})
