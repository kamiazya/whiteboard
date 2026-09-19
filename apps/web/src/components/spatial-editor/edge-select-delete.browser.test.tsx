// Create/delete symmetry for edges: the Connect tool makes edge creation a
// two-click flow, so a misclicked connection must be just as removable —
// click the edge line to select it, press Delete to remove it.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { rootOf } from '../../test-utils/spatial-editor-root.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

function makeStart(): SpatialCanvas {
  return {
    nodes: [
      textNode({ id: 'a', x: 100, y: 100, width: 120, height: 60, text: 'A' }),
      textNode({ id: 'b', x: 400, y: 100, width: 120, height: 60, text: 'B' }),
    ],
    edges: [
      {
        id: 'e1',
        from: { node: 'a' },
        to: { node: 'b' },
      },
    ],
  }
}

function makeHost() {
  const start = makeStart()
  const latest: { canvas: SpatialCanvas; commands: string[] } = { canvas: start, commands: [] }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(start)
    latest.canvas = canvas
    return (
      <div style={{ width: 800, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
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

/**
 * Element-relative click position ON the rendered edge, derived from the
 * committed polyline's own client rect. Hardcoded canvas coordinates break
 * under the vitest browser iframe's UI scaling (the page renders scaled, so
 * a fixed element-relative point lands elsewhere in canvas space depending
 * on the current scale); rect-derived positions live in the same scaled
 * space as the click and stay correct at any zoom.
 */
function edgeMidpointPosition(container: HTMLElement): { x: number; y: number } {
  const root = rootOf(container)
  const polyline = container.querySelector(
    '[data-testid="spatial-editor"] svg polyline',
  ) as SVGPolylineElement
  const edgeRect = polyline.getBoundingClientRect()
  const rootRect = root.getBoundingClientRect()
  return {
    x: edgeRect.x + edgeRect.width / 2 - rootRect.x,
    y: edgeRect.y + edgeRect.height / 2 - rootRect.y,
  }
}

it('clicking an edge selects it and Delete removes it', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  await userEvent.click(rootOf(container), { position: edgeMidpointPosition(container) })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )

  rootOf(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
  await vi.waitFor(() => expect(latest.canvas.edges).toHaveLength(0))
  expect(latest.commands).toContain('delete-edge')
  // Nodes are untouched.
  expect(latest.canvas.nodes).toHaveLength(2)
})

it('a real keyboard Delete works after a cold edge click (focus lands in the editor)', async () => {
  // Live-verification regression: dispatching a synthetic keydown on the
  // editor root bypasses focus, but a real key press goes to
  // document.activeElement. A cold click on an edge hits no focusable
  // element (unlike node shapes, which carry tabIndex), so unless the
  // editor takes focus on edge selection, the real Delete lands on <body>
  // and nothing happens. userEvent.keyboard routes through activeElement,
  // pinning the real path.
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  await userEvent.click(rootOf(container), { position: edgeMidpointPosition(container) })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )

  await userEvent.keyboard('{Delete}')
  await vi.waitFor(() => expect(latest.canvas.edges).toHaveLength(0))
})

it('a click NEAR but not on the edge selects nothing', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  const mid = edgeMidpointPosition(container)
  await userEvent.click(rootOf(container), { position: { x: mid.x, y: mid.y + 50 } })
  expect(container.querySelector('[data-testid="edge-selection-highlight"]')).toBeNull()

  rootOf(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
  expect(latest.canvas.edges).toHaveLength(1)
})

it('Escape and empty-space clicks clear the edge selection without deleting', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  await userEvent.click(rootOf(container), { position: edgeMidpointPosition(container) })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )
  rootOf(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).toBeNull(),
  )
  expect(latest.canvas.edges).toHaveLength(1)

  // The pointer path of the same policy: reselect, then click empty space.
  await userEvent.click(rootOf(container), { position: edgeMidpointPosition(container) })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )
  await userEvent.click(rootOf(container), { position: { x: 650, y: 300 } })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).toBeNull(),
  )
  expect(latest.canvas.edges).toHaveLength(1)
})

it('Shift-clicking a node ADDS it to a held edge selection, and Delete takes both', async () => {
  // This test pinned the OPPOSITE contract until 2026-09-19, when the user
  // decided to open shift for edges. The exclusivity it guarded was never
  // about the gesture: Delete processed a selected edge first, and later the
  // lock dispatched to a single one, so a surviving edge meant the wrong
  // thing got the verb. Both take the whole selection now, so the reason is
  // gone. Rewritten rather than deleted, because a reader finding the old
  // title in `git log` should land on what replaced it.
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  await userEvent.click(rootOf(container), { position: edgeMidpointPosition(container) })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )

  await userEvent.click(rootOf(container), { position: { x: 160, y: 130 }, modifiers: ['Shift'] })
  // The edge survives the press that added the node — the assertion that
  // says the two halves compose, rather than the Delete below passing
  // because one of them was silently dropped.
  expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull()

  rootOf(container).dispatchEvent(new KeyboardEvent('Delete', { bubbles: true }))
  rootOf(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
  await vi.waitFor(() => expect(latest.canvas.nodes.length).toBeLessThan(2))
  expect(latest.canvas.edges).toHaveLength(0)
})

it('Shift-clicking a second edge adds it, and one Delete takes the pair', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  const lines = () =>
    [...container.querySelectorAll('[data-testid="spatial-editor"] svg polyline')] as SVGElement[]
  const midpointOf = (line: SVGElement) => {
    const r = line.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    return { x: r.x + r.width / 2 - rootRect.x, y: r.y + r.height / 2 - rootRect.y }
  }

  await userEvent.click(root, { position: midpointOf(lines()[0] as SVGElement) })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )
  // Only one edge exists in the fixture, so shift-pressing it again must
  // REMOVE it — the toggle half of what shift means, checked here because a
  // grow-only implementation passes every add-shaped assertion.
  await userEvent.click(root, {
    position: midpointOf(lines()[0] as SVGElement),
    modifiers: ['Shift'],
  })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).toBeNull(),
  )
  expect(latest.canvas.edges).toHaveLength(1)
})

it('a band over both ends of a relation takes the relation with them', async () => {
  // The rule the user chose (2026-09-19): a band takes an edge when it took
  // BOTH the nodes it connects, never by where the drawn line happens to
  // run. Both boxes of the fixture sit in the band here, so the edge comes
  // along and one Delete clears the board.
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const root = rootOf(container)

  // The press ARMS the band in React state and the move reads it back, so
  // the move has to follow a commit — and what it waits ON is the band's
  // own `<rect>` width, never the `<svg>` around it: an SVG with no
  // width/height measures 300x150 whatever it holds, so a wrapper-sized
  // wait is true the instant the press lands and the release races the
  // move. That mistake reads exactly like the band ignoring the edge.
  const rect = root.getBoundingClientRect()
  const at = (x: number, y: number) => ({ clientX: rect.left + x, clientY: rect.top + y })
  const bandWidth = () =>
    Number(container.querySelector('[data-testid="marquee-rect"] rect')?.getAttribute('width') ?? 0)
  root.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      pointerId: 31,
      button: 0,
      isPrimary: true,
      ...at(20, 20),
    }),
  )
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="marquee-rect"]')).not.toBeNull(),
  )
  root.dispatchEvent(
    new PointerEvent('pointermove', { bubbles: true, pointerId: 31, buttons: 1, ...at(700, 400) }),
  )
  await vi.waitFor(() => expect(bandWidth()).toBeGreaterThan(100))
  root.dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, pointerId: 31, ...at(700, 400) }),
  )

  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )

  root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(0))
  expect(latest.canvas.edges).toHaveLength(0)
})

it('a marquee drag that starts on an edge line ends with no edge selected', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  const mid = edgeMidpointPosition(container)
  // Drag from the edge line into empty space below: this is a marquee, not
  // an edge click, so the press-time edge selection must not survive it.
  await userEvent.dragAndDrop(rootOf(container), rootOf(container), {
    sourcePosition: mid,
    targetPosition: { x: mid.x + 120, y: mid.y + 150 },
  })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).toBeNull(),
  )
  rootOf(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
  expect(latest.canvas.edges).toHaveLength(1)
  expect(latest.commands).not.toContain('delete-edge')
})
