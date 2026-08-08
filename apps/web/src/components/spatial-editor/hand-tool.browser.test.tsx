// Hand tool: a dock mode where a single pointer drag pans the viewport
// instead of selecting or moving nodes — the one-handed mobile
// navigation path (two-finger pan stays available in every mode).
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
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

it('in hand mode a plain drag pans the viewport — over empty space AND over a node', () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

  const hand = container.querySelector('[data-testid="hand-tool-button"]') as HTMLElement
  expect(hand).not.toBeNull()
  fireEvent.click(hand)
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

it('switching back to select restores normal behavior (drag on a node selects it)', () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement

  fireEvent.click(container.querySelector('[data-testid="hand-tool-button"]') as HTMLElement)
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
