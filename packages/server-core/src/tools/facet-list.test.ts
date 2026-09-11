// The other half of the visibility gap: increment 6a made an agent's
// facet write visible to a human, and this makes the human's registered
// facets discoverable to an agent — which until now had to guess a key.
import { createFacetRegistry, defineFacet, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import { bundledPlugins } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { createFacetListTool, facetListOutputSchema } from './facet-list.js'

const planning = definePlugin({
  id: 'planning',
  displayName: 'Planning',
  facets: [
    defineFacet({
      name: 'due',
      displayName: 'Due',
      version: 'v0',
      targets: ['document', 'node'],
      schema: z.object({ date: z.string(), urgent: z.boolean().optional() }),
    }),
  ],
})

const tool = (registry = createFacetRegistry([...bundledPlugins, planning])) =>
  createFacetListTool({ facetRegistry: registry } as never)

describe('wb_facet_list', () => {
  test('answers every registered facet with the key an agent must write', async () => {
    const result = await tool().execute({})
    const keys = result.facets.map((facet) => facet.key)
    expect(keys).toContain('visual.shape/v0')
    expect(keys).toContain('visual.symbol/v0')
    expect(keys).toContain('planning.due/v0')
    // Ordered by key, so two calls agree and a diff of the output is stable.
    expect(keys).toEqual([...keys].sort())
  })

  test('each entry carries its plugin, targets and payload schema', async () => {
    const result = await tool().execute({})
    const due = result.facets.find((facet) => facet.key === 'planning.due/v0')
    if (due === undefined) throw new Error('planning.due/v0 missing from the list')
    expect(due.namespace).toBe('planning')
    expect(due.displayName).toBe('Planning')
    expect(due.targets).toEqual(['document', 'node'])
    // The schema is what makes the answer actionable: an agent can build a
    // valid payload from it rather than guessing field names.
    expect(due.schema).toMatchObject({ type: 'object' })
    const properties = (due.schema as { properties: Record<string, unknown> }).properties
    expect(Object.keys(properties)).toEqual(['date', 'urgent'])
  })

  test('filters to one target when asked', async () => {
    // `visual.symbol/v0` appears under every target: a symbol answers the
    // same question of a node, a canvas and a document, so it is one facet
    // attachable to all three rather than three facets.
    const canvasOnly = await tool().execute({ target: 'canvas' })
    expect(canvasOnly.facets.map((f) => f.key)).toEqual([
      'visual.edges/v0',
      'visual.symbol/v0',
      'visual.theme/v0',
    ])
    const documentOnly = await tool().execute({ target: 'document' })
    expect(documentOnly.facets.map((f) => f.key)).toEqual(['planning.due/v0', 'visual.symbol/v0'])
  })

  test('the output validates against its own schema', async () => {
    const result = await tool().execute({})
    expect(facetListOutputSchema.safeParse(result).success).toBe(true)
  })

  test('publishes only the targets the engine actually accepts', async () => {
    // ADR-0013 reserves `workspace`; advertising it would promise a write
    // no registry can take. `edge` is implemented and carries visual.edges.
    const result = await tool().execute({})
    const targets = new Set(result.facets.flatMap((facet) => facet.targets))
    expect([...targets].sort()).toEqual(['canvas', 'document', 'edge', 'node'])
  })

  test('a schema JSON Schema cannot express degrades to no schema, and still validates OVER THE WIRE', async () => {
    // z.toJSONSchema refuses a date (and transforms, maps, custom types), so
    // a third-party plugin can reach this. The entry must survive — the key
    // and targets are useful without a schema — and the tool's own output
    // contract must accept the result AFTER serialization, which is what
    // the MCP layer actually sends. Asserting on the in-process object alone
    // passes against a payload the wire would reject.
    const dated = definePlugin({
      id: 'legacy',
      displayName: 'Legacy',
      facets: [
        defineFacet({
          name: 'stamped',
          displayName: 'Stamped',
          version: 'v0',
          targets: ['document'],
          schema: z.object({ at: z.date() }),
        }),
      ],
    })
    const result = await tool(createFacetRegistry([dated])).execute({})
    const entry = result.facets[0]
    if (entry === undefined) throw new Error('legacy.stamped/v0 missing from the list')
    expect(entry.key).toBe('legacy.stamped/v0')
    expect(entry.targets).toEqual(['document'])
    expect(entry.schema).toBeUndefined()
    const overTheWire = JSON.parse(JSON.stringify(result))
    expect(facetListOutputSchema.safeParse(overTheWire).success).toBe(true)
  })

  test('refuses an invalid target or an unknown key, rather than answering something', async () => {
    // The MCP boundary rebuilds a non-strict validator from `.shape`, so a
    // direct server-core caller is the only one this schema's own strictness
    // protects — and an unfiltered or empty answer to a typo'd key is worse
    // than a refusal, because it looks like a result.
    await expect(tool().execute({ target: 'workspace' } as never)).rejects.toThrow()
    await expect(tool().execute({ taget: 'node' } as never)).rejects.toThrow()
  })

  test('a registry with no plugins answers an empty list, not an error', async () => {
    const result = await tool(createFacetRegistry([])).execute({})
    expect(result.facets).toEqual([])
  })
})

describe('wb_facet_list: the registered ASSETS', () => {
  // The ecosystem half of the same visibility gap (ADR-0034 decision 4). A
  // stencil, a theme and an icon set are all vocabulary a DEPLOYMENT
  // registered, and an agent had no way to learn any of them except by
  // failing a write.
  //
  // Reported here rather than enumerated in `wb_canvas_edit`'s schema, and
  // that is a measurement: an enum of stencil ids costs that tool ~38 bytes
  // per stencil per op on every turn — +4838 at 120 stencils, 13% of the
  // whole tool table — for a vocabulary most conversations never touch.
  // This answer costs nothing until somebody asks for it.
  const packed = definePlugin({
    id: 'infra',
    displayName: 'Infra',
    facets: [],
    assets: {
      stencils: {
        bucket: { displayName: 'Bucket', color: '2' },
        lambda: { displayName: 'Lambda', color: '3' },
      },
    },
  })

  test('answers the ids a write must use, namespaced, with what to call them', async () => {
    const result = await tool(createFacetRegistry([...bundledPlugins, packed])).execute({})
    const stencils = result.assets.filter((asset) => asset.kind === 'stencils')
    expect(stencils.map((asset) => asset.id)).toEqual([
      'visual.datastore',
      'visual.service',
      'visual.gateway',
      'visual.queue',
      'visual.actor',
      'visual.external',
      'infra.bucket',
      'infra.lambda',
    ])
    expect(stencils.find((asset) => asset.id === 'infra.bucket')?.displayName).toBe('Bucket')
  })

  test('reports every asset KIND, since a theme is as undiscoverable as a stencil', async () => {
    const result = await tool(createFacetRegistry([...bundledPlugins, packed])).execute({})
    expect([...new Set(result.assets.map((asset) => asset.kind))].sort()).toEqual([
      'stencils',
      'themes',
    ])
  })

  test('filters to one kind, so asking for stencils does not pay for icons', async () => {
    const result = await tool(createFacetRegistry([...bundledPlugins, packed])).execute({
      assetKind: 'stencils',
    })
    expect(result.assets.every((asset) => asset.kind === 'stencils')).toBe(true)
    // ...and the facets are still there: the filter names what to ADD, not
    // a mode that replaces the answer.
    expect(result.facets.length).toBeGreaterThan(0)
  })

  test('answers a registry with no assets as an empty list, not a missing key', async () => {
    const bare = definePlugin({ id: 'bare', displayName: 'Bare', facets: [] })
    const result = await tool(createFacetRegistry([bare])).execute({})
    expect(result.assets).toEqual([])
    // The output schema has to accept it, or the tool violates its own
    // contract exactly when a deployment ships no vocabulary.
    expect(facetListOutputSchema.safeParse(result).success).toBe(true)
  })
})
