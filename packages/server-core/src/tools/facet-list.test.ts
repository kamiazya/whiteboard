// The other half of the visibility gap: increment 6a made an agent's
// facet write visible to a human, and this makes the human's registered
// facets discoverable to an agent — which until now had to guess a key.
import {
  bundledPlugins,
  createFacetRegistry,
  defineFacet,
  definePlugin,
} from '@kamiazya/whiteboard-facet-engine'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { createFacetListTool, facetListOutputSchema } from './facet-list.js'

const planning = definePlugin({
  id: 'planning',
  displayName: 'Planning',
  facets: [
    defineFacet({
      name: 'due',
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
    const canvasOnly = await tool().execute({ target: 'canvas' })
    expect(canvasOnly.facets.map((f) => f.key)).toEqual(['visual.edges/v0'])
    const documentOnly = await tool().execute({ target: 'document' })
    expect(documentOnly.facets.map((f) => f.key)).toEqual(['planning.due/v0'])
  })

  test('the output validates against its own schema', async () => {
    const result = await tool().execute({})
    expect(facetListOutputSchema.safeParse(result).success).toBe(true)
  })

  test('publishes only the targets the engine actually accepts', async () => {
    // ADR-0013 reserves `workspace` and `edge`; advertising them would
    // promise a write no registry can take.
    const result = await tool().execute({})
    const targets = new Set(result.facets.flatMap((facet) => facet.targets))
    expect([...targets].sort()).toEqual(['canvas', 'document', 'node'])
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
