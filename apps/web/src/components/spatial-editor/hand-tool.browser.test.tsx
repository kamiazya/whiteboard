// Hand tool: a dock mode where a single pointer drag pans the viewport
// instead of selecting or moving nodes — the one-handed mobile
// navigation path (two-finger pan stays available in every mode).
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 80, text: 'hello' }],
  edges: [],
}

function makeHost() {
  const latest: { canvas: SpatialCanvas; commands: string[] } = {
    canvas: initial,
    commands: [],
  }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          canvas={canvas}
          onChange={(next, command) => {
            latest.commands.push(command.kind)
            setCanvas(next)
          }}
          theme="light"
          paletteLeading={<span data-testid="host-leading" />}
        />
      </div>
    )
  }
  return { Host, latest }
}

function transformOf(container: HTMLElement): string {
  const vt = container.querySelector('[data-testid="viewport-transform"]') as HTMLElement
  return vt.style.transform
}

function drag(root: HTMLElement, from: [number, number], to: [number, number]) {
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + from[0],
    clientY: r.top + from[1],
  })
  fireEvent.pointerMove(root, {
    pointerId: 1,
    clientX: r.left + to[0],
    clientY: r.top + to[1],
  })
  fireEvent.pointerUp(root, {
    pointerId: 1,
    clientX: r.left + to[0],
    clientY: r.top + to[1],
  })
}

it('hand is the DEFAULT tool and sits leftmost in the tool group', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const hand = container.querySelector('[data-testid="hand-tool-button"]') as HTMLElement
  expect(hand.getAttribute('aria-pressed')).toBe('true')
  const buttons = [...container.querySelectorAll('[data-testid$="-tool-button"]')]
  expect(buttons[0]?.getAttribute('data-testid')).toBe('hand-tool-button')
})

it('in hand mode a plain drag pans the viewport — over empty space AND over a node', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

  // Hand is already active by default — no tool switch needed.
  const hand = container.querySelector('[data-testid="hand-tool-button"]') as HTMLElement
  expect(hand.getAttribute('aria-pressed')).toBe('true')

  const before = transformOf(container)
  drag(root, [500, 400], [420, 340])
  expect(transformOf(container)).not.toBe(before)

  // Over the node (screen 100..300 x 100..180 at identity viewport... after
  // the pan above the node moved; drag across its current screen position):
  const mid = transformOf(container)
  drag(root, [120, 120], [200, 220])
  expect(transformOf(container)).not.toBe(mid)

  // Panning never mutated the canvas and never started a node move.
  expect(latest.commands).toEqual([])
  expect(latest.canvas.nodes[0]).toMatchObject({ x: 100, y: 100 })
  // And no selection was made along the way.
  expect(container.querySelector('[data-testid="selection-overlay"]')).toBeNull()
})

it('hand mode suppresses the long-press context menu — navigation only', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()
  // Android synthesises a contextmenu from a touch long-press; in hand
  // mode that must not surface editing affordances.
  fireEvent.contextMenu(root, { clientX: r.left + 150, clientY: r.top + 130 })
  expect(container.querySelector('[data-testid="context-menu"]')).toBeNull()

  fireEvent.click(container.querySelector('[data-testid="select-tool-button"]') as HTMLElement)
  fireEvent.contextMenu(root, { clientX: r.left + 150, clientY: r.top + 130 })
  expect(container.querySelector('[data-testid="context-menu"]')).not.toBeNull()
})

it('hand mode swaps the leading history cluster for zoom controls; select mode swaps back', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)

  // Hand (default): view-only mode — zoom controls, no host history.
  expect(container.querySelector('[data-testid="host-leading"]')).toBeNull()
  for (const id of ['zoom-out-button', 'zoom-reset-button', 'zoom-in-button', 'zoom-fit-button'])
    expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull()

  fireEvent.click(container.querySelector('[data-testid="select-tool-button"]') as HTMLElement)
  expect(container.querySelector('[data-testid="host-leading"]')).not.toBeNull()
  expect(container.querySelector('[data-testid="zoom-in-button"]')).toBeNull()
})

it('zoom controls: in/out change the scale, reset returns to 100%, zoom-to-fit frames content in the middle', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const vt = () =>
    (container.querySelector('[data-testid="viewport-transform"]') as HTMLElement).style.transform
  const zoomOf = (transform: string) => Number(/scale\(([\d.]+)\)/.exec(transform)?.[1])

  fireEvent.click(container.querySelector('[data-testid="zoom-in-button"]') as HTMLElement)
  expect(zoomOf(vt())).toBeGreaterThan(1)
  const label = container.querySelector('[data-testid="zoom-reset-button"]') as HTMLElement
  expect(label.textContent).not.toBe('100%')

  fireEvent.click(label)
  expect(zoomOf(vt())).toBe(1)
  expect(label.textContent).toBe('100%')

  fireEvent.click(container.querySelector('[data-testid="zoom-out-button"]') as HTMLElement)
  expect(zoomOf(vt())).toBeLessThan(1)

  // Center: the lone node's box (100,100 200x80) centers on the 800x600 root.
  fireEvent.click(container.querySelector('[data-testid="zoom-fit-button"]') as HTMLElement)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()
  const svgRect = (
    container.querySelector('[data-testid="viewport-transform"] svg rect') as SVGRectElement
  ).getBoundingClientRect()
  const cx = svgRect.x + svgRect.width / 2 - r.x
  const cy = svgRect.y + svgRect.height / 2 - r.y
  expect(Math.abs(cx - r.width / 2)).toBeLessThan(2)
  expect(Math.abs(cy - r.height / 2)).toBeLessThan(2)
})

it('switching tools closes an open context menu — no edit affordance survives into hand mode', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()

  fireEvent.click(container.querySelector('[data-testid="select-tool-button"]') as HTMLElement)
  fireEvent.contextMenu(root, { clientX: r.left + 400, clientY: r.top + 300 })
  expect(container.querySelector('[data-testid="context-menu"]')).not.toBeNull()

  fireEvent.click(container.querySelector('[data-testid="hand-tool-button"]') as HTMLElement)
  expect(container.querySelector('[data-testid="context-menu"]')).toBeNull()
})

it('entering hand mode clears edit state: selection, open text editor, armed connect', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  const r = root.getBoundingClientRect()
  const selectBtn = container.querySelector('[data-testid="select-tool-button"]') as HTMLElement
  const handBtn = container.querySelector('[data-testid="hand-tool-button"]') as HTMLElement

  // Selection does not survive into hand mode, so Delete cannot mutate.
  fireEvent.click(selectBtn)
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 150,
    clientY: r.top + 130,
  })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 150, clientY: r.top + 130 })
  expect(container.querySelector('[data-testid="selection-overlay"]')).not.toBeNull()
  fireEvent.click(handBtn)
  expect(container.querySelector('[data-testid="selection-overlay"]')).toBeNull()
  fireEvent.keyDown(root, { key: 'Delete' })
  expect(latest.canvas.nodes).toHaveLength(1)

  // An open text editor closes (uncommitted text is discarded, like Escape).
  fireEvent.click(selectBtn)
  await userEvent.dblClick(root, { position: { x: 150, y: 130 } })
  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
  fireEvent.click(handBtn)
  expect(container.querySelector('textarea')).toBeNull()

  // An armed connect never completes across the mode switch.
  fireEvent.click(container.querySelector('[data-testid="connect-tool-button"]') as HTMLElement)
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 2,
    clientX: r.left + 150,
    clientY: r.top + 130,
  })
  fireEvent.click(handBtn)
  fireEvent.pointerUp(root, { pointerId: 2, clientX: r.left + 150, clientY: r.top + 130 })
  expect(latest.canvas.edges).toHaveLength(0)
  expect(latest.commands).not.toContain('connect-nodes')
})

it('switching to select restores normal behavior (press on a node selects it)', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

  fireEvent.click(container.querySelector('[data-testid="select-tool-button"]') as HTMLElement)

  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 150,
    clientY: r.top + 130,
  })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 150, clientY: r.top + 130 })
  expect(container.querySelector('[data-testid="selection-overlay"]')).not.toBeNull()
})
