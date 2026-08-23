// What the node context menu contributes, now that facets have an inspector:
// a doorway, and only when there is something behind it.
import { createFacetRegistry, defineFacet, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { nodePropertyItems } from './index.js'

const nodeFacet = (name: string) =>
  defineFacet({
    name,
    displayName: name,
    version: 'v0',
    targets: ['node' as const],
    schema: z.object({}),
  })

const withNodeFacet = definePlugin({
  id: 'demo',
  displayName: 'Demo',
  facets: [nodeFacet('one')],
})
const canvasOnly = definePlugin({
  id: 'other',
  displayName: 'Other',
  facets: [
    defineFacet({
      name: 'board',
      displayName: 'Board',
      version: 'v0',
      targets: ['canvas' as const],
      schema: z.object({}),
    }),
  ],
})

describe('nodePropertyItems', () => {
  it('offers one doorway, whatever a plugin contributes', () => {
    let opened = 0
    const items = nodePropertyItems(createFacetRegistry([withNodeFacet]), {
      openPanel: () => {
        opened += 1
      },
    })
    // A separator fences it off from the core rows above; the entry is the
    // only thing this surface knows about facets.
    expect(items.map((i) => i.kind ?? 'action')).toEqual(['separator', 'action'])
    const doorway = items[1]
    if (doorway !== undefined && 'onSelect' in doorway) doorway.onSelect()
    expect(opened).toBe(1)
  })

  it('offers nothing when no facet targets a node — an empty inspector is a dead end', () => {
    expect(nodePropertyItems(createFacetRegistry([canvasOnly]), { openPanel: () => {} })).toEqual(
      [],
    )
  })
})
