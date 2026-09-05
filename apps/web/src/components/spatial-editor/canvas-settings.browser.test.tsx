// The canvas display-settings panel in the vessel that actually opens it:
// the document's ⋯, whose leading `Display…` row hangs the popover off the
// kebab. A pick applies the canvas-wide command immediately and keeps the
// popover open for the next tweak, consecutive picks chain under a deferred
// parent, and dismissal returns focus to the kebab.
import { createFacetRegistry, defineFacet, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { bundledPlugins, type VisualEdgesFacet } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { z } from 'zod'
import { DocumentMenu } from '../workspace-top-bar/DocumentMenu.js'
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
    return (
      <DocumentMenu
        display={<CanvasDisplaySettings canvas={canvas} onChange={(next) => setCanvas(next)} />}
      />
    )
  }
  return { Host, latest }
}

const kebab = (c: HTMLElement) => c.querySelector('[aria-label="More actions"]') as HTMLElement
const menu = () => document.querySelector('[data-testid="canvas-settings-menu"]')
const option = (label: string) =>
  [...(menu()?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === label) as
    | HTMLButtonElement
    | undefined

/**
 * Open the panel the way a person does: REAL clicks on the kebab and its
 * leading row, through the browser's own event and focus sequence.
 *
 * Synthetic `fireEvent.pointerDown`/`pointerUp` drive Radix's menu fine and
 * are what this file used to do — but they skip the focus movement, which
 * is where the defect lived: the closing menu returned focus to the trigger
 * and the popover, having just opened, read that as an outside interaction
 * and dismissed itself. Measured in a real browser: popover present at
 * 50ms and 150ms, gone by 400ms, while every synthetic-event test stayed
 * green.
 */
async function openPanel(container: HTMLElement) {
  await userEvent.click(kebab(container))
  const row = await vi.waitFor(() => {
    const found = [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === 'Display…',
    )
    expect(found).toBeDefined()
    return found as HTMLElement
  })
  await userEvent.click(row)
  // Wait for where focus COMES TO REST, not merely for the panel to appear.
  // A `waitFor(panel exists)` is satisfied by the transient open and reads
  // exactly like a pass; the two builds differ in the end state — focus in
  // the panel, or back on the kebab with the panel gone with it.
  await vi.waitFor(() => {
    expect(document.querySelector('[role="menu"]'), 'the menu is still closing').toBeNull()
    const panel = menu()
    expect(panel, 'the panel closed again as the menu finished closing').toBeTruthy()
    expect(
      panel?.contains(document.activeElement),
      'focus went somewhere other than the panel',
    ).toBe(true)
  })
}

it('the Display row opens the popover with both option rows', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)

  expect(menu()).toBeNull()
  await openPanel(container)
  expect(menu()?.textContent).toContain('Edge routing')
  expect(menu()?.textContent).toContain('Line jumps')
})

it('a pick applies canvas-wide and keeps the popover open; current values are marked', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)

  await openPanel(container)
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
      <DocumentMenu
        display={
          <CanvasDisplaySettings
            canvas={canvas}
            onChange={(next) => {
              setTimeout(() => {
                latest.canvas = next
                setCanvas(next)
              }, 30)
            }}
          />
        }
      />
    )
  }
  const { container } = render(<DeferredHost />)
  await openPanel(container)
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

it('Escape closes and hands focus back to the kebab', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)

  const trigger = kebab(container)
  await openPanel(container)

  fireEvent.keyDown(menu() as HTMLElement, { key: 'Escape' })
  await vi.waitFor(() => expect(menu()).toBeNull())
  // The row that opened this unmounted with the menu, so the popover is
  // anchored on the kebab and hands focus back there — a keyboard user keeps
  // their place instead of falling to <body>.
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
      <DocumentMenu
        display={
          <CanvasDisplaySettings
            canvas={canvas}
            onChange={(next) => setCanvas(next)}
            facetRegistry={registry}
            widgets={{
              ...CANVAS_SETTINGS_WIDGETS,
              'planning.board/v0': () => <div>Board options</div>,
            }}
          />
        }
      />
    )
  }
  const { container } = render(<Host />)
  await openPanel(container)

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
  await openPanel(bare)
  expect(menu()?.querySelector('[role="tab"]')).toBeNull()
})
