// In-app copy/cut/paste (editor-completeness slice 4): Cmd/Ctrl+C/X/V over
// the module-level clipboard store — cross-canvas within the tab, every
// mutation ONE batch command (one undo step), reminted ids on every paste.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { clearClipboardFragmentForTests } from '../../lib/clipboard-store.js'
import type { EditorCommand } from './commands.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)
beforeEach(clearClipboardFragmentForTests)

const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 40, y: 40, width: 160, height: 80, text: 'A' },
    { id: 'b', type: 'text', x: 320, y: 40, width: 160, height: 80, text: 'B' },
  ],
  edges: [{ id: 'ab', fromNode: 'a', toNode: 'b', label: 'kept' }],
}

function makeHost(start: SpatialCanvas = initial) {
  const latest: { canvas: SpatialCanvas; commands: EditorCommand[] } = {
    canvas: start,
    commands: [],
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
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

const rootOf = (container: HTMLElement) =>
  container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

/**
 * Cmd+C/X/V reach the editor as NATIVE clipboard events (see
 * os-clipboard.browser.test.tsx) — with no clipboardData the handlers fall
 * back to the in-app slot, which is what these same-tab cases exercise.
 */
function clip(root: HTMLElement, type: 'copy' | 'cut' | 'paste'): void {
  fireEvent(root, new ClipboardEvent(type, { bubbles: true, cancelable: true }))
}

it('copy then paste clones the selection with reminted ids, offset, as ONE batch', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)

  clip(root, 'copy')
  // Copy never mutates the canvas.
  expect(latest.commands).toHaveLength(0)

  clip(root, 'paste')
  expect(latest.canvas.nodes).toHaveLength(3)
  const copy = latest.canvas.nodes[2]
  expect(copy.id).not.toBe('a')
  expect(copy).toMatchObject({ text: 'A', x: 40 + 16, y: 40 + 16 })
  expect(latest.commands.at(-1)?.kind).toBe('batch')

  // Paste again: reminted afresh, cascading offset from the ORIGINAL copy.
  clip(root, 'paste')
  expect(latest.canvas.nodes).toHaveLength(4)
  expect(new Set(latest.canvas.nodes.map((n) => n.id)).size).toBe(4)
})

it('cut removes the selection as ONE batch and paste restores a reminted copy', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)

  clip(root, 'cut')
  expect(latest.canvas.nodes.map((n) => n.id)).toEqual(['b'])
  // The edge cascaded away with its endpoint.
  expect(latest.canvas.edges).toEqual([])
  expect(latest.commands.at(-1)?.kind).toBe('batch')

  clip(root, 'paste')
  expect(latest.canvas.nodes).toHaveLength(2)
  expect(latest.canvas.nodes[1]).toMatchObject({ text: 'A' })
})

it('cut then paste restores the boundary edge to its surviving peer — cut is a move, not a delete', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)

  clip(root, 'cut')
  expect(latest.canvas.edges).toEqual([])

  clip(root, 'paste')
  const pasted = latest.canvas.nodes.find((n) => n.type === 'text' && n.text === 'A')
  expect(pasted).toBeDefined()
  // The edge to the untouched peer is back, endpoints reminted-side + peer.
  expect(latest.canvas.edges).toHaveLength(1)
  const restored = latest.canvas.edges[0]
  expect([restored.fromNode, restored.toNode].sort()).toEqual([pasted?.id, 'b'].sort())

  // A second paste of the same cut is a plain copy: no second wire onto the peer.
  clip(root, 'paste')
  expect(latest.canvas.nodes).toHaveLength(3)
  expect(latest.canvas.edges).toHaveLength(1)
})

it('copy then paste never wires the duplicate to the original peer', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)

  clip(root, 'copy')
  clip(root, 'paste')
  // The original edge a–b survives untouched; the duplicate arrives bare.
  expect(latest.canvas.nodes).toHaveLength(3)
  expect(latest.canvas.edges).toHaveLength(1)
  expect(latest.canvas.edges[0]).toMatchObject({ fromNode: 'a', toNode: 'b' })
})

it('a multi-selection copy carries the internal edge with properties; paste remaps endpoints', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)
  selectAt(root, 400, 80, true)

  clip(root, 'copy')
  clip(root, 'paste')

  expect(latest.canvas.nodes).toHaveLength(4)
  expect(latest.canvas.edges).toHaveLength(2)
  const pastedIds = new Set(latest.canvas.nodes.slice(2).map((n) => n.id))
  const pastedEdge = latest.canvas.edges[1]
  expect(pastedEdge.label).toBe('kept')
  expect(pastedIds.has(pastedEdge.fromNode)).toBe(true)
  expect(pastedIds.has(pastedEdge.toNode)).toBe(true)
})

it('the clipboard is shared across editor mounts — cross-canvas paste within the tab', () => {
  const a = makeHost()
  const first = render(<a.Host />)
  selectAt(rootOf(first.container), 120, 80)
  clip(rootOf(first.container), 'copy')
  first.unmount()

  const empty: SpatialCanvas = { nodes: [], edges: [] }
  const b = makeHost(empty)
  const second = render(<b.Host />)
  clip(rootOf(second.container), 'paste')
  expect(b.latest.canvas.nodes).toHaveLength(1)
  expect(b.latest.canvas.nodes[0]).toMatchObject({ text: 'A' })
})

it("the empty-space context menu offers 'Paste here', centering the fragment at the click point", () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  selectAt(root, 120, 80)
  clip(root, 'copy')

  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 600, clientY: r.top + 400 })
  const item = [...container.querySelectorAll('[data-testid="context-menu"] button')].find(
    (el) => el.textContent === 'Paste here',
  ) as HTMLElement
  expect(item).toBeDefined()
  fireEvent.click(item)

  const pasted = latest.canvas.nodes[2]
  // Centered on the click point (identity viewport): 600-80, 400-40.
  expect(pasted).toMatchObject({ x: 600 - 80, y: 400 - 40 })
})

it('Cmd+C or Cmd+V with nothing to act on stays inert (browser keeps its own copy/paste)', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)
  clip(root, 'copy')
  clip(root, 'paste')
  expect(latest.commands).toHaveLength(0)
  expect(latest.canvas.nodes).toHaveLength(2)
})
