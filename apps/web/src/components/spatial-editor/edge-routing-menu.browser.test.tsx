// Canvas-wide routing style, set from the display settings panel.
//
// The rendering assertions are the point here: a pick must not just record
// the extension on the canvas, it must change what the scene DRAWS. The
// host composes the panel and the editor over one canvas state, the way
// the page does. The panel's own VESSEL — the inspector slot, its close
// and its fit on a phone — is pinned at the page level in
// BrowserDocumentPage.display-panel.browser.test.tsx; nothing here needs
// to open anything, so the panel is simply mounted.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { VisualEdgesFacet } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { CanvasDisplaySettings } from './CanvasDisplaySettings.js'
import { SpatialEditor } from './SpatialEditor.js'

const edgesFacetOf = (canvas: SpatialCanvas) =>
  canvas.facets?.['visual.edges/v0'] as VisualEdgesFacet | undefined

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 40, y: 40, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 400, y: 240, width: 120, height: 60, text: 'B' },
  ],
  edges: [
    {
      id: 'e1',
      from: { kind: 'node' as const, node: 'a' },
      to: { kind: 'node' as const, node: 'b' },
    },
  ],
}

function makeHost() {
  const latest = { canvas: initial }
  function Host() {
    const [canvas, setCanvas] = useState(initial)
    latest.canvas = canvas
    return (
      <div style={{ width: 900, height: 700 }}>
        <div data-testid="display-settings">
          <CanvasDisplaySettings canvas={canvas} onChange={(next) => setCanvas(next)} />
        </div>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
        />
      </div>
    )
  }
  return { Host, latest }
}

// Radix's DropdownMenuTrigger opens on pointerDown and its Item selects on
// pointerUp, so neither step is a plain click.
async function openSettings(container: HTMLElement) {
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="display-settings"]')).not.toBeNull()
  })
}

const optionButton = (container: HTMLElement, label: string) =>
  container.querySelector(`[data-testid="display-settings"] input[aria-label="${label}"]`) as
    | HTMLInputElement
    | undefined

it('offers the routing style from the display panel, not the creation menu', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  await openSettings(container)

  expect(container.querySelector('[data-testid="display-settings"]')).not.toBeNull()
  expect(container.textContent).toContain('Edge routing')
  expect(optionButton(container, 'Orthogonal')).toBeDefined()

  // The dock's "+" menu is for what does not exist yet; a canvas-wide setting
  // must not appear there.
  const addButton = container.querySelector('[data-testid="add-button"]') as HTMLButtonElement
  addButton.click()
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="add-menu"]')).not.toBeNull()
  })
  expect(container.querySelector('[data-testid="add-menu"]')?.textContent).not.toContain('routing')
})

it('records the choice on the canvas and bends the edge', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  await openSettings(container)

  await vi.waitFor(() => expect(optionButton(container, 'Orthogonal')).toBeDefined())
  optionButton(container, 'Orthogonal')?.click()

  await vi.waitFor(() => {
    expect(edgesFacetOf(latest.canvas)?.routing).toBe('orthogonal')
  })
  // The scene follows: a bent edge has more than the two endpoint points.
  await vi.waitFor(() => {
    const polyline = container.querySelector('polyline')
    expect(polyline?.getAttribute('points')?.split(' ').length).toBeGreaterThan(2)
  })
})

// Straight is the default, so choosing it must leave no trace — otherwise
// every canvas anyone opened the menu on carries a redundant extension.
it('drops the setting again when the style returns to straight', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  await openSettings(container)
  await vi.waitFor(() => expect(optionButton(container, 'Orthogonal')).toBeDefined())
  optionButton(container, 'Orthogonal')?.click()
  await vi.waitFor(() => expect(edgesFacetOf(latest.canvas)?.routing).toBe('orthogonal'))

  // The panel stays put after a pick — flip straight from the same surface.
  await vi.waitFor(() => expect(optionButton(container, 'Straight')).toBeDefined())
  optionButton(container, 'Straight')?.click()

  await vi.waitFor(() => {
    expect(latest.canvas).not.toHaveProperty('x-whiteboard')
  })
})

// Curved was withheld from the menu while it rendered as a straight line. It
// belongs there now, and what makes it real is a <path> in the scene rather
// than the entry existing.
it('draws a curve when the canvas asks for one', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  await openSettings(container)

  await vi.waitFor(() => expect(optionButton(container, 'Curved')).toBeDefined())
  optionButton(container, 'Curved')?.click()

  await vi.waitFor(() => {
    expect(edgesFacetOf(latest.canvas)?.routing).toBe('curved')
  })
  await vi.waitFor(() => {
    const path = container.querySelector('[data-testid="viewport-transform"] path')
    expect(path?.getAttribute('d')).toContain('Q')
    expect(path?.getAttribute('fill')).toBe('none')
  })
})

// Line jumps ride the same canvas menu as the routing style: crossing edges
// hop over each other so their directions stay readable.
it('toggles line jumps from the canvas menu and draws the hop arc', async () => {
  const crossed: SpatialCanvas = {
    nodes: [
      { id: 'a', type: 'text', x: 0, y: 145, width: 50, height: 50, text: 'a' },
      { id: 'b', type: 'text', x: 500, y: 145, width: 50, height: 50, text: 'b' },
      { id: 'c', type: 'text', x: 250, y: 0, width: 50, height: 50, text: 'c' },
      { id: 'd', type: 'text', x: 250, y: 400, width: 50, height: 50, text: 'd' },
    ],
    edges: [
      {
        id: 'e1',
        from: { kind: 'node' as const, node: 'a' },
        to: { kind: 'node' as const, node: 'b' },
      },
      {
        id: 'e2',
        from: { kind: 'node' as const, node: 'c' },
        to: { kind: 'node' as const, node: 'd' },
      },
    ],
  }
  const latest = { canvas: crossed }
  function CrossHost() {
    const [canvas, setCanvas] = useState(crossed)
    latest.canvas = canvas
    return (
      <div style={{ width: 900, height: 700 }}>
        <div data-testid="display-settings">
          <CanvasDisplaySettings canvas={canvas} onChange={(next) => setCanvas(next)} />
        </div>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
        />
      </div>
    )
  }
  const { container } = render(<CrossHost />)
  await openSettings(container)

  await vi.waitFor(() => expect(optionButton(container, 'On')).toBeDefined())
  optionButton(container, 'On')?.click()

  await vi.waitFor(() => {
    expect(edgesFacetOf(latest.canvas)?.lineJumps).toBe('arc')
  })
  // The crossing edge is now a path with a hop arc.
  await vi.waitFor(() => {
    const arcPath = [...container.querySelectorAll('svg path')].find((p) =>
      (p.getAttribute('d') ?? '').includes('A 5 5'),
    )
    expect(arcPath).toBeDefined()
  })

  // Off leaves no trace on the canvas (same open panel).
  await vi.waitFor(() => expect(optionButton(container, 'Off')).toBeDefined())
  optionButton(container, 'Off')?.click()
  await vi.waitFor(() => {
    expect(latest.canvas).not.toHaveProperty('x-whiteboard')
  })
})

// Two picks from the SAME open menu can land before a slow parent commits
// the first — the handlers must chain off the eagerly-updated ref, not the
// stale prop, or the second command erases the first setting.
it('consecutive style + jumps picks both survive a deferred parent', async () => {
  const latest = { canvas: initial }
  function DeferredHost() {
    const [canvas, setCanvas] = useState(initial)
    latest.canvas = canvas
    const deferSet = (next: SpatialCanvas) => {
      setTimeout(() => {
        latest.canvas = next
        setCanvas(next)
      }, 30)
    }
    return (
      <div style={{ width: 900, height: 700 }}>
        <div data-testid="display-settings">
          <CanvasDisplaySettings canvas={canvas} onChange={deferSet} />
        </div>
        <SpatialEditor defaultTool="select" canvas={canvas} onChange={deferSet} theme="light" />
      </div>
    )
  }
  const { container } = render(<DeferredHost />)
  await openSettings(container)

  await vi.waitFor(() => expect(optionButton(container, 'Orthogonal')).toBeDefined())
  optionButton(container, 'Orthogonal')?.click()
  optionButton(container, 'On')?.click()

  await vi.waitFor(() => {
    expect(edgesFacetOf(latest.canvas)).toEqual({
      routing: 'orthogonal',
      lineJumps: 'arc',
    })
  })
})
