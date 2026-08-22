// The namespace-container rule for the node context menu: one contributing
// namespace renders bare bands; a second namespace introduces displayName
// headings, in namespace-ID order regardless of the display wording.
import { createFacetRegistry, defineFacet, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type NodePropertiesWidget, nodePropertyItems } from './index.js'

const node = { id: 'n1', type: 'text' as const, x: 0, y: 0, width: 10, height: 10, text: '' }
const ctx = { node, applyToSelection: () => {} }

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
    expect(items.map((i) => (i.kind === 'heading' ? `#${i.label}` : i.kind))).toEqual([
      '#Zeta styling',
      'options',
      '#Apple tools',
      'options',
    ])
  })

  it('a single contributing namespace renders bare bands — no heading', () => {
    const registry = createFacetRegistry([zeta, apple])
    // apple has no widget registered, so only zeta actually contributes.
    const widgets = { 'aaa-zeta.one/v0': band('One') }
    const items = nodePropertyItems(registry, ctx, widgets)
    expect(items.map((i) => i.kind)).toEqual(['options'])
  })
})
