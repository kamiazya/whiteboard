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
      <InspectorPanel kind="display" onClose={() => {}}>
        <CanvasDisplaySettings canvas={canvas} onChange={(next) => setCanvas(next)} />
      </InspectorPanel>
    )
  }
  return { Host, latest }
}

const menu = () => document.querySelector('[data-testid="display-panel"]')
/**
 * An option, by its accessible name — a real radio now, not a button, so
 * `checked` is what says it is current rather than `aria-pressed`.
 */
const option = (label: string) =>
  menu()?.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | undefined
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
    expect(latest.canvas.facets?.['visual.theme/v0']).toEqual({
      theme: 'visual.neon',
    })
  })
  expect(menu()).toBeTruthy()
  expect(themeRadio('Neon').checked).toBe(true)

  fireEvent.click(themeRadio('Default'))
  await vi.waitFor(() => {
    expect(latest.canvas.facets?.['visual.theme/v0']).toBeUndefined()
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
  await vi.waitFor(() => expect(option('Orthogonal')?.checked).toBe(true))
  expect(edgesFacetOf(latest.canvas)).toBeUndefined()

  fireEvent.click(option('Straight') as HTMLElement)
  await vi.waitFor(() => expect(edgesFacetOf(latest.canvas)?.routing).toBe('straight'))
  expect(option('Straight')?.checked).toBe(true)
  expect(option('Orthogonal')?.checked).toBe(false)
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
  expect(option('Curved')?.checked).toBe(true)

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
  // writes. The options come from the plugin's own DECLARATION, so the
  // canvas offers exactly the set a node does.
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
    expect(latest.canvas.facets?.['visual.symbol/v0']).toEqual({
      kind: 'emoji',
      char: '⭐',
    }),
  )

  fireEvent.click(menu()?.querySelector('[aria-label="No symbol"]') as HTMLElement)
  // Removed without a trace: a canvas that chose and reverted serializes
  // like one that never chose.
  await vi.waitFor(() => expect(latest.canvas.facets?.['visual.symbol/v0']).toBeUndefined())
})

/**
 * Every row in the panel draws ONE control.
 *
 * They drew four. `visual.symbol` had a hand-written component (a
 * radiogroup with its radios hidden behind an accent fill), `visual.theme`
 * derived a segmented control with no glyphs — so its radios were VISIBLE
 * beside a word, the only round radios in the panel — `visual.shape`
 * derived the same control WITH glyphs, which drew a bordered pill, and
 * Edge routing / Line jumps were `aria-pressed` buttons written by hand in
 * this vessel. One job, four looks, all in one panel.
 *
 * The measurement is structural rather than a class-name check: what went
 * wrong was three different ELEMENT shapes, and a class assertion would
 * have passed over all three.
 *
 * What it catches, measured: drawing the picker as `aria-pressed` buttons
 * — the spelling being unified away — fails this and two neighbours. What
 * it does NOT catch, also measured: a plugin declaring a `component` again.
 * That is not a hole in the test but a property of this surface — a canvas
 * settings row goes through the derived form whatever the plugin declares,
 * so a component cannot reach here at all. It can still reach the NODE
 * inspector, and holding every surface to one control is a scan's job, not
 * this file's.
 */
it('draws every row through the one selection control', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  await openPanel(container)
  const panel = menu() as HTMLElement

  // Every row, facet-contributed or hand-written by this vessel. The SET,
  // not the order — which row comes first is the contribution point's
  // business and has its own test.
  const groups = [...panel.querySelectorAll('[role="radiogroup"]')]
  expect(groups.map((g) => g.getAttribute('aria-label')).sort()).toEqual([
    'Edge routing',
    'Line jumps',
    'Symbol',
    'Theme',
  ])

  // Every option in every group is the same thing: a real radio (so arrow
  // keys work, which the button rows never had), visually hidden, inside a
  // label that carries the accessible name.
  for (const group of groups) {
    const options = [...group.querySelectorAll('label')]
    expect(options.length).toBeGreaterThan(1)
    for (const option of options) {
      const input = option.querySelector('input[type="radio"]')
      expect(input, `${option.getAttribute('title') ?? '?'} is not a radio`).not.toBeNull()
      expect(input?.getAttribute('aria-label')).toBeTruthy()
      // Hidden, not absent: a visible radio beside a word is the spelling
      // that made Theme look unlike its neighbours.
      expect(Math.round((input as HTMLElement).getBoundingClientRect().width)).toBeLessThan(2)
    }
  }
})

/**
 * Every option in the panel is a PICTURE. Whether its word is drawn beside
 * the picture is the row's LAYOUT, and both layouts are here on purpose.
 *
 * The one control shape landed first and the panel still read as a list of
 * sentences: five rows, four of them entirely words, twelve of twenty-four
 * options spelled out. A person scanning it read rather than recognised.
 *
 * - **cards** — a picture over its word, in a bordered cell, the shape
 *   Settings already gives theme and tab icon. For a short vocabulary whose
 *   names carry meaning a picture cannot fully take on: Edge routing, Line
 *   jumps, Theme.
 * - **chips** — a picture alone, its word the accessible name and the
 *   `title`. For a palette where the count makes labels impossible and the
 *   glyph is the whole affordance: Symbol's twelve.
 *
 * A count cannot decide which — that is why the plugin declares it. What is
 * pinned here is that no option is a bare word either way.
 */
it('draws every option as a picture, in the layout its row declares', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  await openPanel(container)
  const panel = menu() as HTMLElement

  const options = [...panel.querySelectorAll('[role="radiogroup"] label')]
  // A count, so a selector that stops matching cannot report itself as a
  // panel with nothing left to check.
  expect(options.length).toBeGreaterThanOrEqual(10)
  for (const option of options) {
    const name = option.querySelector('input')?.getAttribute('aria-label') ?? '?'
    expect(option.querySelector('[aria-hidden="true"]'), `${name} draws no glyph`).not.toBeNull()
  }

  // The three card rows print their word; the chip row does not, and hands
  // it to `title` instead so it is still reachable by hover and by a reader.
  const rowOf = (label: string) =>
    panel.querySelector(`[role="radiogroup"][aria-label="${label}"]`) as HTMLElement
  for (const label of ['Edge routing', 'Line jumps', 'Theme']) {
    const first = rowOf(label).querySelector('label') as HTMLElement
    const name = first.querySelector('input')?.getAttribute('aria-label') ?? '?'
    expect(first.textContent?.trim(), `${label}: ${name} prints no word`).toBe(name)
    expect(
      first.getAttribute('title'),
      `${label}: ${name} repeats its word in a tooltip`,
    ).toBeNull()
  }
  for (const option of [...rowOf('Symbol').querySelectorAll('label')]) {
    const name = option.querySelector('input')?.getAttribute('aria-label') ?? '?'
    // The clipped radio contributes no text, so what is left is what shows.
    expect(option.textContent?.trim(), `Symbol: ${name} shows its word`).not.toBe(name)
    expect(option.getAttribute('title'), `Symbol: ${name} has no title`).toBe(name)
  }
})

/**
 * One way to say "none", not two.
 *
 * The derived form used to add a `Clear` button whenever anything was
 * stored, beside a `Default` option that already meant the same thing — and
 * the button's visible text was the bare word "Clear", naming nothing it
 * would clear (the facet was in its `aria-label` only). A picker carries
 * absence as an ordinary option, so the button has nothing left to do.
 */
it('offers no Clear beside a picker that already has a none option', async () => {
  const { Host, latest } = makeHost()
  const { container } = render(<Host />)
  await openPanel(container)

  const neon = await vi.waitFor(() => {
    const el = menu()?.querySelector('[aria-label="Neon"]')
    expect(el).not.toBeNull()
    return el as HTMLElement
  })
  fireEvent.click(neon)
  await vi.waitFor(() =>
    expect(latest.canvas.facets?.['visual.theme/v0']).toEqual({
      theme: 'visual.neon',
    }),
  )

  // Something IS stored now — the state that used to grow a Clear button.
  expect(
    [...(menu()?.querySelectorAll('button') ?? [])].filter((b) =>
      /clear/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
    ),
  ).toEqual([])

  // And the none option is what takes it back.
  fireEvent.click(menu()?.querySelector('[aria-label="Default"]') as HTMLElement)
  await vi.waitFor(() => expect(latest.canvas.facets?.['visual.theme/v0']).toBeUndefined())
})

/**
 * EVERY row in the panel, not only the facet ones.
 *
 * Edge routing and Line jumps were hand-written `aria-pressed` button rows
 * in this vessel — the third spelling in this one panel. A button wearing `aria-pressed` is a TOGGLE: a screen
 * reader hears "pressed", not "1 of 3 selected", and there is no arrow-key
 * movement between the options because the element never promised any.
 *
 * So the panel holds no `aria-pressed` selection control at all now. The
 * attribute keeps its real job elsewhere (a tool, a rail opener) — what it
 * must not do is stand in for a choice among alternatives.
 */
it('leaves no aria-pressed selection control anywhere in the panel', async () => {
  const { Host } = makeHost()
  const { container } = render(<Host />)
  await openPanel(container)
  const panel = menu() as HTMLElement

  const pressed = [...panel.querySelectorAll('[aria-pressed]')].map(
    (el) => el.getAttribute('aria-label') ?? el.textContent?.trim(),
  )
  expect(pressed).toEqual([])
})
