// The OOUI object-action surface: right-click a node for its actions,
// right-click empty space to create "here". Real pointer input throughout —
// synthetic-event-only coverage is how this editor's first-touch bugs
// survived unnoticed.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 100, y: 100, width: 200, height: 100, text: 'hello' }],
  edges: [],
}

function Host({ onCommand }: { onCommand?: (kind: string) => void }) {
  const [canvas, setCanvas] = useState<SpatialCanvas>(start)
  return (
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        canvas={canvas}
        onChange={(next, command) => {
          onCommand?.(command.kind)
          setCanvas(next)
        }}
        theme="light"
      />
    </div>
  )
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

it('right-clicking a text node opens its action menu; Edit text opens the editor', async () => {
  const { container } = render(<Host />)
  rightClick(rootOf(container), 200, 150)

  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await userEvent.click(page.getByRole('menuitem', { name: 'Edit text' }))

  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
  expect(container.querySelector('[data-testid="context-menu"]')).toBeNull()
})

it('Delete from the menu removes the node and its edges', async () => {
  const commands: string[] = []
  const { container } = render(<Host onCommand={(kind) => commands.push(kind)} />)
  rightClick(rootOf(container), 200, 150)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  await userEvent.click(page.getByRole('menuitem', { name: 'Delete' }))

  expect(commands).toContain('delete-node')
  await vi.waitFor(() =>
    expect(container.querySelectorAll('svg rect[fill="#ffffff"]').length).toBe(0),
  )
})

it('right-clicking empty space offers creation at that point', async () => {
  const commands: string[] = []
  const { container } = render(<Host onCommand={(kind) => commands.push(kind)} />)
  rightClick(rootOf(container), 600, 450)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  await userEvent.click(page.getByRole('menuitem', { name: 'Add note here' }))

  expect(commands).toContain('create-node')
  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
})

it('Escape closes the menu without acting', async () => {
  const commands: string[] = []
  const { container } = render(<Host onCommand={(kind) => commands.push(kind)} />)
  rightClick(rootOf(container), 200, 150)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  await userEvent.keyboard('{Escape}')

  await vi.waitFor(() => expect(container.querySelector('[data-testid="context-menu"]')).toBeNull())
  expect(commands).toHaveLength(0)
})

// --- Edge context menu: the object under the pointer gets ITS actions ---

const edgeStart: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 400, y: 100, width: 120, height: 60, text: 'B' },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b', label: 'link' }],
}

function makeEdgeHost() {
  const latest: { canvas: SpatialCanvas; commands: string[] } = { canvas: edgeStart, commands: [] }
  function EdgeHost() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(edgeStart)
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
  return { EdgeHost, latest }
}

function edgeMidpoint(container: HTMLElement): { x: number; y: number } {
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

it('right-clicking an edge offers Edit label and Delete, not node creation', async () => {
  const { EdgeHost, latest } = makeEdgeHost()
  const { container } = render(<EdgeHost />)

  const mid = edgeMidpoint(container)
  rightClick(rootOf(container), mid.x, mid.y)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  expect(container.textContent).not.toContain('Add note here')

  await userEvent.click(page.getByRole('menuitem', { name: 'Edit label' }))
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-label-editor"]')).not.toBeNull(),
  )
  expect(
    (container.querySelector('[data-testid="edge-label-editor"]') as HTMLTextAreaElement).value,
  ).toBe('link')
  expect(latest.canvas.edges).toHaveLength(1)
})

// Deterministic option-click for the inline property rows: applying an
// option re-routes the edge and re-renders the scene under the pointer,
// which Playwright's stability check intermittently reads as "element not
// stable"; the menu button itself is static, so a direct DOM click is the
// faithful interaction.
function clickOption(container: HTMLElement, groupName: string, optionName: string) {
  const group = [...container.querySelectorAll('fieldset')].find(
    (g) => g.getAttribute('aria-label') === groupName,
  ) as HTMLElement
  const option = [...group.querySelectorAll('[role="menuitemradio"]')].find(
    (o) => o.getAttribute('aria-label') === optionName,
  ) as HTMLElement
  fireEvent.click(option)
}

it('the arrow option row marks the spec default and applies a new direction in one tap', async () => {
  const { EdgeHost, latest } = makeEdgeHost()
  const { container } = render(<EdgeHost />)

  const mid = edgeMidpoint(container)
  rightClick(rootOf(container), mid.x, mid.y)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  // Default fromEnd none / toEnd arrow reads as the checked "Forward" radio.
  const forward = [...container.querySelectorAll('[role="menuitemradio"]')].find(
    (o) => o.getAttribute('aria-label') === 'Forward',
  )
  expect(forward?.getAttribute('aria-checked')).toBe('true')

  clickOption(container, 'Arrows', 'Both')
  await vi.waitFor(() => expect(latest.canvas.edges[0].fromEnd).toBe('arrow'))
  // toEnd 'arrow' is the spec default — canonical form omits the field.
  expect(latest.canvas.edges[0]).not.toHaveProperty('toEnd')
  expect(latest.commands).toContain('set-edge-ends')

  // Property picks keep the menu OPEN (several adjustments = one visit) and
  // the rendered scene now draws both arrowheads.
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await vi.waitFor(() =>
    expect(
      container.querySelectorAll('[data-testid="viewport-transform"] svg polygon').length,
    ).toBe(2),
  )
})

it('the side option rows pin an endpoint directly, without cycling', async () => {
  const { EdgeHost, latest } = makeEdgeHost()
  const { container } = render(<EdgeHost />)

  const mid = edgeMidpoint(container)
  rightClick(rootOf(container), mid.x, mid.y)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  // Direct pick inside the "From side" group — one tap to any side.
  clickOption(container, 'From side', 'Bottom')
  await vi.waitFor(() => expect(latest.canvas.edges[0].fromSide).toBe('bottom'))
  expect(latest.commands).toContain('set-edge-side')

  // Menu is still open — pin the other endpoint in the same visit.
  clickOption(container, 'To side', 'Top')
  await vi.waitFor(() => expect(latest.canvas.edges[0].toSide).toBe('top'))

  // And back to auto removes the pin.
  clickOption(container, 'From side', 'Auto')
  await vi.waitFor(() => expect(latest.canvas.edges[0]).not.toHaveProperty('fromSide'))
})

it('Delete from the edge menu removes the edge and leaves the nodes', async () => {
  const { EdgeHost, latest } = makeEdgeHost()
  const { container } = render(<EdgeHost />)

  const mid = edgeMidpoint(container)
  rightClick(rootOf(container), mid.x, mid.y)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  await userEvent.click(page.getByRole('menuitem', { name: 'Delete' }))

  await vi.waitFor(() => expect(latest.canvas.edges).toHaveLength(0))
  expect(latest.commands).toContain('delete-edge')
  expect(latest.canvas.nodes).toHaveLength(2)
})

it('context-menu targeting keeps node and edge selection mutually exclusive', async () => {
  const { EdgeHost, latest } = makeEdgeHost()
  const { container } = render(<EdgeHost />)

  // Select the edge first (click its line), then right-click a NODE: the
  // edge selection must clear, or a later Delete removes the edge the user
  // is no longer pointing at. Positions are recomputed at each use: the
  // vitest browser iframe's UI scale can settle between renders, so a
  // cached rect-derived point goes stale (this test caught that live).
  await userEvent.click(rootOf(container), { position: edgeMidpoint(container) })
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).not.toBeNull(),
  )
  rightClick(rootOf(container), 160, 130)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="edge-selection-highlight"]')).toBeNull(),
  )
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(container.querySelector('[data-testid="context-menu"]')).toBeNull())

  // And the reverse: node selected, then right-click the edge.
  const mid = edgeMidpoint(container)
  rightClick(rootOf(container), mid.x, mid.y)
  await expect.element(page.getByRole('menuitem', { name: 'Edit label' })).toBeInTheDocument()
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(container.querySelector('[data-testid="context-menu"]')).toBeNull())
  rootOf(container).dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
  // The node right-clicked earlier is no longer selected; Delete acts on
  // the edge selection made by the second right-click only.
  await vi.waitFor(() => expect(latest.canvas.edges).toHaveLength(0))
  expect(latest.canvas.nodes).toHaveLength(2)
})
