// The OOUI object-action surface: right-click a node for its actions,
// right-click empty space to create "here". Real pointer input throughout —
// synthetic-event-only coverage is how this editor's first-touch bugs
// survived unnoticed.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { CREATION_LABELS } from './creation-labels.js'
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
        defaultTool="select"
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

  await userEvent.click(page.getByRole('menuitem', { name: 'Note' }))

  expect(commands).toContain('create-node')
  await vi.waitFor(() => expect(container.querySelector('textarea')).not.toBeNull())
})

it('empty space offers the full creation set, anchored at the click point', async () => {
  const { Host, latest } = (() => {
    const l: { canvas: SpatialCanvas; commands: string[] } = { canvas: start, commands: [] }
    function H() {
      const [canvas, setCanvas] = useState<SpatialCanvas>(start)
      l.canvas = canvas
      return (
        <div style={{ width: 800, height: 600 }}>
          <SpatialEditor
            defaultTool="select"
            canvas={canvas}
            onChange={(next, command) => {
              l.commands.push(command.kind)
              setCanvas(next)
            }}
            theme="light"
            fileRefOptions={[{ file: 'c1', label: 'Other canvas' }]}
          />
        </div>
      )
    }
    return { Host: H, latest: l }
  })()
  const { container } = render(<Host />)
  rightClick(rootOf(container), 600, 450)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  // The dock's + menu creation set, repeated "here" (canvas entry appears
  // because the host supplies the reference seam).
  // Image is absent because this host supplies no image storage seam; the
  // rest is the whole creation set, in the same words the dock uses.
  for (const label of [
    CREATION_LABELS.note,
    CREATION_LABELS.link,
    CREATION_LABELS.group,
    CREATION_LABELS.document,
  ]) {
    expect(container.textContent).toContain(label)
  }

  await userEvent.click(page.getByRole('menuitem', { name: 'Group' }))
  await vi.waitFor(() => expect(latest.canvas.nodes.some((n) => n.type === 'group')).toBe(true))
  const frame = latest.canvas.nodes.find((n) => n.type === 'group')
  if (frame === undefined) throw new Error('frame missing')
  // Centered on the click point (600,450 screen = canvas at identity view).
  expect(frame.x + frame.width / 2).toBeCloseTo(600, 0)
  expect(frame.y + frame.height / 2).toBeCloseTo(450, 0)
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
  expect(container.textContent).not.toContain('Note')

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

it('a menu opened near the right/bottom edge is nudged back inside the editor', async () => {
  const { container } = render(<Host />)
  rightClick(rootOf(container), 795, 590)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  const menu = container.querySelector('[data-testid="context-menu"]') as HTMLElement
  const root = rootOf(container).getBoundingClientRect()
  const rect = menu.getBoundingClientRect()
  // The clamp keeps a 4px gap, not mere containment — a regression that
  // flushes the menu against the edge must fail here too.
  expect(rect.right).toBeLessThanOrEqual(root.right - 4)
  expect(rect.bottom).toBeLessThanOrEqual(root.bottom - 4)
  expect(rect.left).toBeGreaterThanOrEqual(root.left)
  expect(rect.top).toBeGreaterThanOrEqual(root.top)
})

// --- Color row: presets are one-tap picks on both node and edge menus ---

function makeNodeHost() {
  const latest: { canvas: SpatialCanvas; commands: string[] } = { canvas: start, commands: [] }
  function NodeHost() {
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
  return { NodeHost, latest }
}

it('the node Color row applies a preset in one tap and Default removes it', async () => {
  const { NodeHost, latest } = makeNodeHost()
  const { container } = render(<NodeHost />)
  rightClick(rootOf(container), 200, 150)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  // The swatch chip must actually paint: a default-inline span ignores
  // size-* and lays out 0x0 (a real defect caught live), so pin its box.
  const colorGroup = [...container.querySelectorAll('fieldset')].find(
    (g) => g.getAttribute('aria-label') === 'Color',
  ) as HTMLElement
  // firstElementChild twice: button > icon wrapper > swatch chip. A `span
  // span` selector would match the wrapper itself (its ancestor span sits
  // outside the button, but querySelector still counts it).
  const redSwatch = [...colorGroup.querySelectorAll('[role="menuitemradio"]')].find(
    (o) => o.getAttribute('aria-label') === 'Red',
  )?.firstElementChild?.firstElementChild as HTMLElement
  expect(redSwatch.getBoundingClientRect().width).toBeGreaterThan(0)
  expect(redSwatch.style.backgroundColor).not.toBe('')

  clickOption(container, 'Color', 'Red')
  await vi.waitFor(() => expect(latest.canvas.nodes[0].color).toBe('1'))
  expect(latest.commands).toContain('set-node-color')

  // Property picks keep the menu open, and the scene re-renders with the
  // preset accent: the node's chrome rect now carries the palette stroke.
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()
  const accent = SPATIAL_LIGHT_PALETTE.presets['1']
  await vi.waitFor(() =>
    expect(
      container.querySelector(
        `[data-testid="viewport-transform"] svg rect[stroke="${accent.stroke}"]`,
      ),
    ).not.toBeNull(),
  )

  clickOption(container, 'Color', 'Default')
  await vi.waitFor(() => expect(latest.canvas.nodes[0]).not.toHaveProperty('color'))
})

it('the edge Color row recolors the stroke via the palette preset', async () => {
  const { EdgeHost, latest } = makeEdgeHost()
  const { container } = render(<EdgeHost />)

  const mid = edgeMidpoint(container)
  rightClick(rootOf(container), mid.x, mid.y)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  clickOption(container, 'Color', 'Purple')
  await vi.waitFor(() => expect(latest.canvas.edges[0].color).toBe('6'))
  expect(latest.commands).toContain('set-edge-color')

  const accent = SPATIAL_LIGHT_PALETTE.presets['6']
  await vi.waitFor(() =>
    expect(
      container.querySelector(
        `[data-testid="viewport-transform"] svg polyline[stroke="${accent.stroke}"]`,
      ),
    ).not.toBeNull(),
  )
})

// Recoloring FROM a multi-selection styles the whole selected area: every
// member node, and every edge that runs between two members. It used to
// touch only the right-clicked node, silently ignoring the rest of the
// selection — and edges could not follow an area recolor at all.
it('the Color row from a multi-selection recolors every member and the edges between them', async () => {
  const areaStart: SpatialCanvas = {
    nodes: [
      { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'A' },
      { id: 'b', type: 'text', x: 300, y: 100, width: 120, height: 60, text: 'B' },
      { id: 'c', type: 'text', x: 500, y: 300, width: 120, height: 60, text: 'C' },
    ],
    edges: [
      { id: 'ab', fromNode: 'a', toNode: 'b' },
      { id: 'bc', fromNode: 'b', toNode: 'c' },
    ],
  }
  const latest: { canvas: SpatialCanvas } = { canvas: areaStart }
  function AreaHost() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(areaStart)
    latest.canvas = canvas
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
  const { container } = render(<AreaHost />)
  const root = rootOf(container)

  // Select a + b (c stays out), then right-click member a.
  await userEvent.click(root, { position: { x: 160, y: 130 } })
  await userEvent.click(root, { position: { x: 360, y: 130 }, modifiers: ['Shift'] })
  rightClick(root, 160, 130)
  await expect.element(page.getByTestId('context-menu')).toBeInTheDocument()

  clickOption(container, 'Color', 'Red')

  await vi.waitFor(() => {
    expect(latest.canvas.nodes.find((n) => n.id === 'a')?.color).toBe('1')
    expect(latest.canvas.nodes.find((n) => n.id === 'b')?.color).toBe('1')
  })
  // The edge INSIDE the selected area follows; the edge leaving it does not.
  expect(latest.canvas.edges.find((e) => e.id === 'ab')?.color).toBe('1')
  expect(latest.canvas.edges.find((e) => e.id === 'bc')?.color).toBeUndefined()
  expect(latest.canvas.nodes.find((n) => n.id === 'c')?.color).toBeUndefined()
})
