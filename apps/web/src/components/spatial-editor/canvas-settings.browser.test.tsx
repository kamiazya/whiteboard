// The canvas display-settings panel in the vessel that actually holds it:
// `InspectorPanel`, the page's one inspector slot (`lib/inspector.ts`). A
// pick applies the canvas-wide command immediately and leaves the panel
// standing for the next tweak, and consecutive picks chain under a
// deferred parent.
//
// It was a popover off the ⋯ kebab before, which brought a dismissal dance
// this file used to pin: the popover had to open on the MENU'S close, and
// hand focus back to the kebab by hand. None of it survives the move —
// the slot's own close is `InspectorPanel`'s, and the phone case that
// motivated the move (no Escape, no outside left to press) is pinned at
// the page level in BrowserDocumentPage.display-panel.browser.test.tsx.
import { createFacetRegistry, defineFacet, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { bundledPlugins, type VisualEdgesFacet } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { InspectorPanel } from '../document-editor/InspectorPanel.js'
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
      <InspectorPanel kind="display" onClose={() => {}}>
        <CanvasDisplaySettings canvas={canvas} onChange={(next) => setCanvas(next)} />
      </InspectorPanel>
    )
  }
  return { Host, latest }
}

const menu = () => document.querySelector('[data-testid="display-panel"]')
const option = (label: string) =>
  [...(menu()?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === label) as
    | HTMLButtonElement
    | undefined

/** The panel stands in the slot from mount; nothing has to open it. */
async function openPanel(_container: HTMLElement) {
  await vi.waitFor(() => expect(menu()).toBeTruthy())
}

it('stands in the inspector slot with both option rows', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)

  await openPanel(container)
  expect(menu()?.textContent).toContain('Edge routing')
  expect(menu()?.textContent).toContain('Line jumps')
  expect(menu()?.textContent).toContain('Theme')
})

it('a theme pick writes visual.theme to the canvas envelope; Default clears it', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const themeRadio = (label: string) =>
    menu()?.querySelector(`input[type="radio"][aria-label="${label}"]`) as HTMLInputElement

  await openPanel(container)
  await vi.waitFor(() => expect(themeRadio('Neon')).toBeTruthy())
  fireEvent.click(themeRadio('Neon'))
  await vi.waitFor(() => {
    expect(latest.canvas['x-whiteboard']?.facets?.['visual.theme/v0']).toEqual({
      theme: 'visual.neon',
    })
  })
  expect(menu()).toBeTruthy()
  expect(themeRadio('Neon').checked).toBe(true)

  fireEvent.click(themeRadio('Default'))
  await vi.waitFor(() => {
    expect(latest.canvas['x-whiteboard']?.facets?.['visual.theme/v0']).toBeUndefined()
  })
})

it('under a theme the routing row marks the theme default, and Straight over it sticks', async () => {
  // The theme's routing is the canvas's DEFAULT (ADR-0030 decision 4), so
  // the row has to show it as current — and a person choosing Straight over
  // it is making a choice, which must be recorded rather than dropped as
  // "the default" for the theme to overrule.
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  const themeRadio = (label: string) =>
    menu()?.querySelector(`input[type="radio"][aria-label="${label}"]`) as HTMLInputElement

  await openPanel(container)
  await vi.waitFor(() => expect(themeRadio('Neon')).toBeTruthy())
  fireEvent.click(themeRadio('Neon'))
  await vi.waitFor(() => expect(option('Orthogonal')?.getAttribute('aria-pressed')).toBe('true'))
  expect(edgesFacetOf(latest.canvas)).toBeUndefined()

  fireEvent.click(option('Straight') as HTMLElement)
  await vi.waitFor(() => expect(edgesFacetOf(latest.canvas)?.routing).toBe('straight'))
  expect(option('Straight')?.getAttribute('aria-pressed')).toBe('true')
  expect(option('Orthogonal')?.getAttribute('aria-pressed')).toBe('false')
})

it('a pick applies canvas-wide and leaves the panel up; current values are marked', async () => {
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
      <InspectorPanel kind="display" onClose={() => {}}>
        <CanvasDisplaySettings
          canvas={canvas}
          onChange={(next) => {
            setTimeout(() => {
              latest.canvas = next
              setCanvas(next)
            }, 30)
          }}
        />
      </InspectorPanel>
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
      <InspectorPanel kind="display" onClose={() => {}}>
        <CanvasDisplaySettings
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          facetRegistry={registry}
          widgets={{
            ...CANVAS_SETTINGS_WIDGETS,
            'planning.board/v0': () => <div>Board options</div>,
          }}
        />
      </InspectorPanel>
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

it('lets a person give the document its own mark, and take it back', async () => {
  // The entry point everything else this facet feeds depends on: the tab,
  // the file row and — where there is room — the overview all read what this
  // writes. The picker is the plugin's OWN, so the canvas offers exactly the
  // set a node does.
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  await openPanel(container)

  const pick = await vi.waitFor(() => {
    const el = menu()?.querySelector('[aria-label="Emoji ⭐"]')
    expect(el).not.toBeNull()
    return el as HTMLElement
  })
  fireEvent.click(pick)
  await vi.waitFor(() =>
    expect(latest.canvas['x-whiteboard']?.facets?.['visual.symbol/v0']).toEqual({
      kind: 'emoji',
      char: '⭐',
    }),
  )

  fireEvent.click(menu()?.querySelector('[aria-label="No symbol"]') as HTMLElement)
  // Removed without a trace: a canvas that chose and reverted serializes
  // like one that never chose.
  await vi.waitFor(() =>
    expect(latest.canvas['x-whiteboard']?.facets?.['visual.symbol/v0']).toBeUndefined(),
  )
})
