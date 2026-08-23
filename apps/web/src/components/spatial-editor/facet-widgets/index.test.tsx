// The namespace-container rule for the node context menu: EVERY contributing
// namespace gets its displayName heading, the whole region is fenced off from
// the core rows by a separator, and groups order by namespace ID regardless of
// the display wording.
import { createFacetRegistry, defineFacet, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type NodePropertiesWidget, nodePropertyItems } from './index.js'

const node = { id: 'n1', type: 'text' as const, x: 0, y: 0, width: 10, height: 10, text: '' }
const ctx = { node, applyToSelection: () => {}, openPanel: () => {} }

const nodeFacet = (name: string) =>
  defineFacet({ name, version: 'v0', targets: ['node' as const], schema: z.object({}) })

const band =
  (label: string): NodePropertiesWidget =>
  () => [{ kind: 'options' as const, label, options: [] }]

// zeta before apple by DISPLAY name — id order must win.
const zeta = definePlugin({
  id: 'aaa-zeta',
  displayName: 'Zeta styling',
  facets: [nodeFacet('one')],
})
const apple = definePlugin({
  id: 'zzz-apple',
  displayName: 'Apple tools',
  facets: [nodeFacet('two')],
})

describe('nodePropertyItems', () => {
  it('two namespaces get displayName headings, ordered by namespace id', () => {
    const registry = createFacetRegistry([zeta, apple])
    const widgets = { 'aaa-zeta.one/v0': band('One'), 'zzz-apple.two/v0': band('Two') }
    const items = nodePropertyItems(registry, ctx, widgets)
    expect(items.map((i) => (i.kind === 'heading' ? `#${i.label}` : (i.kind ?? 'action')))).toEqual(
      ['separator', '#Zeta styling', 'options', '#Apple tools', 'options', 'action'],
    )
  })

  it('a single contributing namespace is headed too — the region needs a boundary', () => {
    const registry = createFacetRegistry([zeta, apple])
    // apple has no widget registered, so only zeta actually contributes.
    const widgets = { 'aaa-zeta.one/v0': band('One') }
    const items = nodePropertyItems(registry, ctx, widgets)
    expect(items.map((i) => (i.kind === 'heading' ? `#${i.label}` : (i.kind ?? 'action')))).toEqual(
      ['separator', '#Zeta styling', 'options', 'action'],
    )
  })

  it("the panel doorway is the vessel's, not the core surface's", () => {
    const registry = createFacetRegistry([zeta])
    let opened = 0
    const items = nodePropertyItems(
      registry,
      {
        ...ctx,
        openPanel: () => {
          opened += 1
        },
      },
      { 'aaa-zeta.one/v0': band('One') },
    )
    const doorway = items.find((i) => i.kind === undefined || i.kind === 'action')
    expect(doorway).toBeDefined()
    if (doorway !== undefined && 'onSelect' in doorway) doorway.onSelect()
    expect(opened).toBe(1)
  })

  it('contributes nothing at all when no namespace has a band', () => {
    // No separator, no doorway: an empty region must not leave a stray rule
    // across the menu.
    expect(nodePropertyItems(createFacetRegistry([zeta]), ctx, {})).toEqual([])
  })
})

describe('a declared band is legible', () => {
  const shaped = definePlugin({
    id: 'demo',
    displayName: 'Demo',
    facets: [
      defineFacet({
        name: 'place',
        version: 'v0',
        targets: ['node' as const],
        schema: z.object({ align: z.enum(['start', 'center']) }),
        editor: {
          fields: {
            align: {
              widget: 'segmented',
              label: 'Text',
              quick: true,
              options: [
                { value: null, label: 'Default', glyph: 'none' },
                { value: 'start', label: 'Top' },
                { value: 'center', label: 'Middle' },
              ],
            },
          },
        },
      }),
    ],
  })

  it('an option with no drawable glyph shows its declared label, not nothing', () => {
    const items = nodePropertyItems(createFacetRegistry([shaped]), ctx, {})
    const band = items.find((i) => i.kind === 'options')
    // `icon` is a React ELEMENT even when the component renders nothing, so
    // passing one unconditionally made the vessel choose the icon branch and
    // draw an empty button. Three blank boxes, measured at 28px each.
    expect(band?.kind === 'options' ? band.options.map((o) => o.label) : []).toEqual([
      'Default',
      'Top',
      'Middle',
    ])
    const glyphless = band?.kind === 'options' ? band.options.slice(1) : []
    expect(glyphless.map((o) => o.icon)).toEqual([undefined, undefined])
  })
})
