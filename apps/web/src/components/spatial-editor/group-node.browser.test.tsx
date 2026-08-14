// Group nodes (JSON Canvas `type: 'group'`): an empty frame from the
// palette, "Group selection" framing a multi-selection, geometric
// containment moves (the frame carries fully-contained nodes), label
// editing, and frame deletion that keeps members. Real pointer input for
// the drag/double-press paths.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const grouped: SpatialCanvas = {
  nodes: [
    // Frame first = bottom of the z-order, members drawn (and hit) above.
    { id: 'g1', type: 'group', x: 80, y: 80, width: 360, height: 220, label: 'cluster' },
    { id: 'a', type: 'text', x: 120, y: 120, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 280, y: 200, width: 120, height: 60, text: 'B' },
    // Outside the frame — must NOT move with it.
    { id: 'c', type: 'text', x: 600, y: 400, width: 120, height: 60, text: 'C' },
  ],
  edges: [],
}

function makeHost(initial: SpatialCanvas) {
  const latest: { canvas: SpatialCanvas; commands: string[] } = { canvas: initial, commands: [] }
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
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

function rootOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
}

function rightClick(el: HTMLElement, x: number, y: number) {
  const r = el.getBoundingClientRect()
  el.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + x,
      clientY: r.top + y,
      button: 2,
    }),
  )
}

function nodeById(latest: { canvas: SpatialCanvas }, id: string) {
  const node = latest.canvas.nodes.find((n) => n.id === id)
  if (node === undefined) throw new Error(`node ${id} missing`)
  return node
}

it('the palette Add group button creates an empty frame at the bottom of the z-order', async () => {
  const { Host, latest } = makeHost({ nodes: [], edges: [] })
  render(<Host />)

  await userEvent.click(page.getByRole('button', { name: 'Add' }))
  await userEvent.click(page.getByRole('menuitem', { name: 'Group' }))
  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(1))
  expect(latest.canvas.nodes[0]).toMatchObject({ type: 'group' })
  expect(latest.commands).toContain('create-group')
})

it('dragging the frame moves its contained members and leaves outsiders alone', async () => {
  const { Host, latest } = makeHost(grouped)
  const { container } = render(<Host />)
  const root = rootOf(container)

  // Press inside the frame but OUTSIDE both members (frame padding area),
  // so the hit resolves to the group, then drag it 60,40.
  await userEvent.click(root, { position: { x: 100, y: 100 } })
  fireEvent.pointerDown(root, { pointerId: 1, clientX: 100, clientY: 100, buttons: 1 })
  fireEvent.pointerMove(root, { pointerId: 1, clientX: 160, clientY: 140, buttons: 1 })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: 160, clientY: 140 })

  await vi.waitFor(() => expect(nodeById(latest, 'g1')).toMatchObject({ x: 140, y: 120 }))
  expect(nodeById(latest, 'a')).toMatchObject({ x: 180, y: 160 })
  expect(nodeById(latest, 'b')).toMatchObject({ x: 340, y: 240 })
  // The outsider never moved.
  expect(nodeById(latest, 'c')).toMatchObject({ x: 600, y: 400 })
})

it('dragging a member inside the frame moves only that member', async () => {
  const { Host, latest } = makeHost(grouped)
  const { container } = render(<Host />)
  const root = rootOf(container)

  fireEvent.pointerDown(root, { pointerId: 1, clientX: 180, clientY: 150, buttons: 1 })
  fireEvent.pointerMove(root, { pointerId: 1, clientX: 200, clientY: 170, buttons: 1 })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: 200, clientY: 170 })

  await vi.waitFor(() => expect(nodeById(latest, 'a')).toMatchObject({ x: 140, y: 140 }))
  expect(nodeById(latest, 'g1')).toMatchObject({ x: 80, y: 80 })
  expect(nodeById(latest, 'b')).toMatchObject({ x: 280, y: 200 })
})

it('a real double-click on the frame edits its label; empty commit removes it', async () => {
  const { Host, latest } = makeHost(grouped)
  const { container } = render(<Host />)
  const root = rootOf(container)

  await userEvent.dblClick(root, { position: { x: 100, y: 100 } })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="group-label-editor"]')).not.toBeNull(),
  )
  const editor = container.querySelector(
    '[data-testid="group-label-editor"]',
  ) as HTMLTextAreaElement
  expect(editor.value).toBe('cluster')

  await userEvent.fill(editor, 'phase 1')
  await userEvent.click(root, { position: { x: 700, y: 300 } })
  await vi.waitFor(() => expect(nodeById(latest, 'g1')).toMatchObject({ label: 'phase 1' }))
  expect(latest.commands).toContain('set-group-label')

  // Clearing the label through the SAME UI path (fill empty + blur-commit)
  // removes the field — the reducer's empty-removes rule reached from the
  // editor, not only from commands.test.ts.
  await userEvent.dblClick(root, { position: { x: 100, y: 100 } })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="group-label-editor"]')).not.toBeNull(),
  )
  const reopened = container.querySelector(
    '[data-testid="group-label-editor"]',
  ) as HTMLTextAreaElement
  await userEvent.fill(reopened, '')
  await userEvent.click(root, { position: { x: 700, y: 300 } })
  await vi.waitFor(() => expect(nodeById(latest, 'g1')).not.toHaveProperty('label'))
})

it('Group selection from a multi-selected node frames the selection with padding', async () => {
  const twoLoose: SpatialCanvas = {
    nodes: [
      { id: 'a', type: 'text', x: 120, y: 120, width: 120, height: 60, text: 'A' },
      { id: 'b', type: 'text', x: 300, y: 220, width: 120, height: 60, text: 'B' },
    ],
    edges: [],
  }
  const { Host, latest } = makeHost(twoLoose)
  const { container } = render(<Host />)
  const root = rootOf(container)

  // Marquee-select both nodes.
  fireEvent.pointerDown(root, { pointerId: 1, clientX: 60, clientY: 60, buttons: 1 })
  fireEvent.pointerMove(root, { pointerId: 1, clientX: 500, clientY: 400, buttons: 1 })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: 500, clientY: 400 })
  // The overlay outlines the region the handles act on; membership is marked
  // per node, primary included (same split marquee.browser.test.tsx asserts).
  await vi.waitFor(() =>
    expect(container.querySelectorAll('[data-testid="member-outlines"] rect').length).toBe(2),
  )

  rightClick(root, 180, 150)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await userEvent.click(page.getByRole('menuitem', { name: 'Group selection' }))

  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(3))
  const frame = latest.canvas.nodes[0]
  // Enclosing box (120,120)-(420,280) plus the 24px padding on every side.
  expect(frame).toMatchObject({ type: 'group', x: 96, y: 96, width: 348, height: 208 })
})

// A member that paints BELOW its frame (member first, frame later in
// document order) is still fully visible through the unfilled frame, so a
// press on it must select and move the member — it used to be unreachable,
// every click resolving to the frame above it.
it('a member painted below the frame is still selectable and draggable', async () => {
  const memberBelowFrame: SpatialCanvas = {
    nodes: [
      { id: 'a', type: 'text', x: 120, y: 120, width: 120, height: 60, text: 'A' },
      { id: 'g1', type: 'group', x: 80, y: 80, width: 360, height: 220, label: 'cluster' },
    ],
    edges: [],
  }
  const { Host, latest } = makeHost(memberBelowFrame)
  const { container } = render(<Host />)
  const root = rootOf(container)

  // Press ON the member, drag 40,20 — the member moves, the frame stays.
  await userEvent.click(root, { position: { x: 180, y: 150 } })
  fireEvent.pointerDown(root, { pointerId: 1, clientX: 180, clientY: 150, buttons: 1 })
  fireEvent.pointerMove(root, { pointerId: 1, clientX: 220, clientY: 170, buttons: 1 })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: 220, clientY: 170 })

  await vi.waitFor(() => expect(nodeById(latest, 'a')).toMatchObject({ x: 160, y: 140 }))
  expect(nodeById(latest, 'g1')).toMatchObject({ x: 80, y: 80 })
})

it('deleting the frame keeps its members', async () => {
  const { Host, latest } = makeHost(grouped)
  const { container } = render(<Host />)
  const root = rootOf(container)

  rightClick(root, 100, 100)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await userEvent.click(page.getByRole('menuitem', { name: 'Delete' }))

  await vi.waitFor(() => expect(latest.canvas.nodes.some((n) => n.type === 'group')).toBe(false))
  expect(latest.canvas.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c'])
})

it('a palette-created frame that lands off-screen pans the viewport to show it', async () => {
  // The viewport center is fully occupied, so the free-spot cascade pushes
  // the new frame outside the visible viewport — creation must bring it
  // back into view instead of leaving the user staring at nothing.
  const crowded: SpatialCanvas = {
    nodes: [
      { id: 'wall', type: 'text', x: -400, y: -300, width: 1600, height: 1200, text: 'wall' },
    ],
    edges: [],
  }
  const { Host, latest } = makeHost(crowded)
  const { container } = render(<Host />)

  // The wall node covers the palette in the unstyled test env (no app CSS =
  // no z-index), so Playwright refuses the click — the buttons themselves
  // are static, so direct DOM clicks are the faithful interaction.
  fireEvent.click(container.querySelector('[data-testid="add-button"]') as HTMLElement)
  fireEvent.click(
    [...container.querySelectorAll('[data-testid="add-menu"] [role="menuitem"]')].find(
      (b) => b.getAttribute('aria-label') === 'Group',
    ) as HTMLElement,
  )
  await vi.waitFor(() => expect(latest.canvas.nodes.some((n) => n.type === 'group')).toBe(true))

  const root = rootOf(container).getBoundingClientRect()
  await vi.waitFor(() => {
    const frameRect = [
      ...(container.querySelectorAll(
        '[data-testid="viewport-transform"] svg rect',
      ) as NodeListOf<SVGRectElement>),
    ]
      .filter((r) => Number(r.getAttribute('width')) >= 300)
      .map((r) => r.getBoundingClientRect())[0]
    expect(frameRect).toBeDefined()
    expect(frameRect.left).toBeGreaterThanOrEqual(root.left)
    expect(frameRect.top).toBeGreaterThanOrEqual(root.top)
    expect(frameRect.right).toBeLessThanOrEqual(root.right)
    expect(frameRect.bottom).toBeLessThanOrEqual(root.bottom)
  })
})

it('Group selection can frame a selection that includes a group frame', async () => {
  const mixed: SpatialCanvas = {
    nodes: [
      { id: 'g1', type: 'group', x: 80, y: 80, width: 200, height: 140 },
      { id: 'a', type: 'text', x: 120, y: 120, width: 100, height: 60, text: 'A' },
      { id: 'b', type: 'text', x: 400, y: 120, width: 120, height: 60, text: 'B' },
    ],
    edges: [],
  }
  const { Host, latest } = makeHost(mixed)
  const { container } = render(<Host />)
  const root = rootOf(container)

  // Marquee over everything: frame, its member, and the loose node.
  fireEvent.pointerDown(root, { pointerId: 1, clientX: 40, clientY: 40, buttons: 1 })
  fireEvent.pointerMove(root, { pointerId: 1, clientX: 600, clientY: 400, buttons: 1 })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: 600, clientY: 400 })
  await vi.waitFor(() =>
    expect(
      container.querySelectorAll('[data-testid="member-outlines"] rect').length,
    ).toBeGreaterThanOrEqual(2),
  )

  rightClick(root, 450, 150)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await userEvent.click(page.getByRole('menuitem', { name: 'Group selection' }))

  // A new OUTER frame prepends, enclosing the inner frame and both nodes
  // (min corner 80,80 / max corner 520,220, plus 24px padding).
  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(4))
  expect(latest.canvas.nodes[0]).toMatchObject({
    type: 'group',
    x: 56,
    y: 56,
    width: 488,
    height: 188,
  })
})
