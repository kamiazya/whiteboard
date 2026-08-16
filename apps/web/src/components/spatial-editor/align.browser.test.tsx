// Align/distribute in the editor. The geometry itself is unit-tested in
// align.test.ts; this pins the wiring: which selections get the affordance,
// that one action is one undo step, and that a locked node is never moved
// by it.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { EditorCommand } from './commands.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

// Three different-sized boxes, none of them aligned, laid out so a marquee
// from the top-left can sweep all three.
const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 40, y: 40, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 220, y: 160, width: 80, height: 100, text: 'B' },
    { id: 'c', type: 'text', x: 420, y: 260, width: 60, height: 40, text: 'C' },
  ],
  edges: [],
}

function makeHost(lockedNodes: readonly string[] = []) {
  const latest: { canvas: SpatialCanvas; commands: EditorCommand[] } = {
    canvas: initial,
    commands: [],
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
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

/** Marquee from empty space across every node. */
function selectAll(root: HTMLElement) {
  fireEvent.keyDown(root, { code: 'KeyA', key: 'a', metaKey: true })
}

function openMenuOn(root: HTMLElement, x: number, y: number) {
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + x, clientY: r.top + y })
}

function clickOption(container: HTMLElement, ariaLabel: string) {
  const button = container.querySelector(
    `[data-testid="context-menu"] [aria-label="${ariaLabel}"]`,
  ) as HTMLElement
  expect(button, `no menu option labelled ${ariaLabel}`).toBeTruthy()
  fireEvent.click(button)
}

const byId = (canvas: SpatialCanvas, id: string) => canvas.nodes.find((node) => node.id === id)!

it('aligns the whole selection to its left edge in one undo step', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  selectAll(root)
  openMenuOn(root, 100, 70) // over node 'a', which is in the selection
  latest.commands.length = 0
  clickOption(container, 'Align left')

  expect(byId(latest.canvas, 'a').x).toBe(40)
  expect(byId(latest.canvas, 'b').x).toBe(40)
  expect(byId(latest.canvas, 'c').x).toBe(40)
  // One batch, not three moves: an align is one user action.
  expect(latest.commands).toHaveLength(1)
  expect(latest.commands[0]).toMatchObject({ kind: 'batch' })
})

it('aligns to the bottom edge, accounting for differing heights', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  selectAll(root)
  openMenuOn(root, 100, 70)
  clickOption(container, 'Align bottom')

  // Bottom-most edge is c's 260 + 40 = 300 — the shortest node, not the
  // lowest-positioned one, so aligning by y alone would land elsewhere.
  expect(byId(latest.canvas, 'a').y).toBe(240)
  expect(byId(latest.canvas, 'b').y).toBe(200)
  expect(byId(latest.canvas, 'c').y).toBe(260)
})

it('distributes the middle node so the gaps are equal', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  selectAll(root)
  openMenuOn(root, 100, 70)
  clickOption(container, 'Distribute horizontally')

  // Span 40..480 = 440, widths 260 → gap 90; b lands at 40+120+90 = 250.
  expect(byId(latest.canvas, 'a').x).toBe(40)
  expect(byId(latest.canvas, 'b').x).toBe(250)
  expect(byId(latest.canvas, 'c').x).toBe(420)
})

it('offers neither row for a single-node selection', () => {
  const { Host } = makeHost()
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

  const labels = [...container.querySelectorAll('[data-testid="context-menu"]')].map(
    (el) => el.textContent ?? '',
  )
  expect(labels.join(' ')).not.toContain('Align')
  expect(labels.join(' ')).not.toContain('Distribute')
})

it('hides only Distribute when the selection has exactly two nodes', () => {
  const two: SpatialCanvas = { nodes: initial.nodes.slice(0, 2), edges: [] }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(two)
    return (
      <div style={{ width: 900, height: 700 }}>
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
  const root = rootOf(container)

  selectAll(root)
  openMenuOn(root, 100, 70)
  const text = (container.querySelector('[data-testid="context-menu"]')?.textContent ??
    '') as string
  expect(text).toContain('Align')
  expect(text).not.toContain('Distribute')
})

it('never moves a locked node, and never counts it toward the bounds', () => {
  // 'c' is locked, so select-all skips it — the alignment must be computed
  // from a and b alone, leaving c exactly where it was.
  const { Host, latest } = makeHost(['c'])
  const { container } = render(<Host />)
  const root = rootOf(container)

  selectAll(root)
  openMenuOn(root, 100, 70)
  clickOption(container, 'Align left')

  expect(byId(latest.canvas, 'a').x).toBe(40)
  expect(byId(latest.canvas, 'b').x).toBe(40)
  expect(byId(latest.canvas, 'c')).toMatchObject({ x: 420, y: 260 })
})

it('emits nothing when the selection is already aligned', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  selectAll(root)
  openMenuOn(root, 100, 70)
  clickOption(container, 'Align left')
  latest.commands.length = 0

  openMenuOn(root, 100, 70)
  clickOption(container, 'Align left')
  // Already flush: no second undo step to step back through.
  expect(latest.commands).toHaveLength(0)
})

it('leaves edges alone — align moves nodes only', () => {
  const withEdge: SpatialCanvas = { ...initial, edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }] }
  const seen = vi.fn()
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(withEdge)
    seen(canvas)
    return (
      <div style={{ width: 900, height: 700 }}>
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
  const root = rootOf(container)

  selectAll(root)
  openMenuOn(root, 100, 70)
  clickOption(container, 'Align left')

  const latest = seen.mock.calls.at(-1)?.[0] as SpatialCanvas
  expect(latest.edges).toEqual(withEdge.edges)
})
