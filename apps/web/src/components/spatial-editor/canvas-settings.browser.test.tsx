// The canvas display-settings popover, standalone: the gear opens it, a
// pick applies the canvas-wide command immediately and keeps it open for
// the next tweak, consecutive picks chain under a deferred parent, and
// dismissal returns focus to the gear.
import {
  bundledPlugins,
  createFacetRegistry,
  defineFacet,
  definePlugin,
  type VisualEdgesFacet,
} from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CanvasDisplaySettings } from './CanvasDisplaySettings.js'
import { CANVAS_SETTINGS_WIDGETS } from './facet-widgets/index.js'

const edgesFacetOf = (canvas: SpatialCanvas) =>
  canvas['x-whiteboard']?.facets?.['visual.edges/v0'] as VisualEdgesFacet | undefined

afterEach(cleanup)

const initial: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 40, y: 40, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 400, y: 240, width: 120, height: 60, text: 'B' },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
}

function makeHost() {
  const latest = { canvas: initial }
  function Host() {
    const [canvas, setCanvas] = useState(initial)
    latest.canvas = canvas
    return <CanvasDisplaySettings canvas={canvas} onChange={(next) => setCanvas(next)} />
  }
  return { Host, latest }
}

const gear = (c: HTMLElement) =>
  c.querySelector('[data-testid="canvas-settings-button"]') as HTMLElement
const menu = () => document.querySelector('[data-testid="canvas-settings-menu"]')
const option = (label: string) =>
  [...(menu()?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === label) as
    | HTMLButtonElement
    | undefined

it('the gear opens the popover with both option rows', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)

  expect(menu()).toBeNull()
  fireEvent.click(gear(container))
  await vi.waitFor(() => expect(menu()).toBeTruthy())
  expect(menu()?.textContent).toContain('Edge routing')
  expect(menu()?.textContent).toContain('Line jumps')
})

it('a pick applies canvas-wide and keeps the popover open; current values are marked', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  fireEvent.click(gear(container))
  await vi.waitFor(() => expect(option('Curved')).toBeDefined())
  fireEvent.click(option('Curved') as HTMLElement)

  await vi.waitFor(() => {
    expect(edgesFacetOf(latest.canvas)?.routing).toBe('curved')
  })
  expect(menu()).toBeTruthy()
  expect(option('Curved')?.getAttribute('aria-pressed')).toBe('true')

  fireEvent.click(option('On') as HTMLElement)
  await vi.waitFor(() => {
    expect(edgesFacetOf(latest.canvas)?.lineJumps).toBe('arc')
  })
})

it('consecutive picks both survive a deferred parent', async () => {
  const latest = { canvas: initial }
  function DeferredHost() {
    const [canvas, setCanvas] = useState(initial)
    latest.canvas = canvas
    return (
      <CanvasDisplaySettings
        canvas={canvas}
        onChange={(next) => {
          setTimeout(() => {
            latest.canvas = next
            setCanvas(next)
          }, 30)
        }}
      />
    )
  }
  const { container } = render(<DeferredHost />)
  fireEvent.click(gear(container))
  await vi.waitFor(() => expect(option('Orthogonal')).toBeDefined())
  fireEvent.click(option('Orthogonal') as HTMLElement)
  fireEvent.click(option('On') as HTMLElement)

  await vi.waitFor(() => {
    expect(edgesFacetOf(latest.canvas)).toEqual({
      routing: 'orthogonal',
      lineJumps: 'arc',
    })
  })
})

it('Escape closes and hands focus back to the gear', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)

  const trigger = gear(container)
  fireEvent.click(trigger)
  await vi.waitFor(() => expect(menu()).toBeTruthy())

  fireEvent.keyDown(menu() as HTMLElement, { key: 'Escape' })
  await vi.waitFor(() => expect(menu()).toBeNull())
  // Radix hands focus back to the trigger, so a keyboard user keeps their
  // place instead of falling to <body>.
  await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
})

it('a second contributing namespace introduces displayName tabs; one namespace stays bare', async () => {
  const planning = definePlugin({
    id: 'planning',
    displayName: 'Planning',
    facets: [
      defineFacet({
        name: 'board',
        displayName: 'Board',
        version: 'v0',
        targets: ['canvas'],
        schema: z.object({}),
      }),
    ],
  })
  const registry = createFacetRegistry([...bundledPlugins, planning])
  function Host() {
    const [canvas, setCanvas] = useState(initial)
    return (
      <CanvasDisplaySettings
        canvas={canvas}
        onChange={(next) => setCanvas(next)}
        facetRegistry={registry}
        widgets={{
          ...CANVAS_SETTINGS_WIDGETS,
          'planning.board/v0': () => <div>Board options</div>,
        }}
      />
    )
  }
  const { container } = render(<Host />)
  fireEvent.click(gear(container))
  await vi.waitFor(() => expect(menu()).toBeTruthy())

  const tabs = [...(menu()?.querySelectorAll('[role="tab"]') ?? [])]
  expect(tabs.map((t) => t.textContent)).toEqual(['Planning', 'Visual style'])
  // First namespace by id is active: planning's panel shows, visual's not.
  expect(menu()?.textContent).toContain('Board options')
  expect(menu()?.textContent).not.toContain('Edge routing')
  fireEvent.click(tabs[1] as HTMLElement)
  await vi.waitFor(() => expect(menu()?.textContent).toContain('Edge routing'))

  cleanup()
  // The bundled registry alone (one namespace) shows no tablist.
  const { Host: BareHost } = makeHost()
  const { container: bare } = render(<BareHost />)
  fireEvent.click(gear(bare))
  await vi.waitFor(() => expect(menu()).toBeTruthy())
  expect(menu()?.querySelector('[role="tab"]')).toBeNull()
})
