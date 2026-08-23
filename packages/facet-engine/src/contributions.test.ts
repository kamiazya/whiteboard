// The contribution resolution layer: core surfaces ask "what does this
// point carry" and get namespace groups derived mechanically from facet
// targets — no surface ever names a plugin or facet key itself.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { resolveFacetContributions } from './contributions.js'
import { createFacetRegistry, defineFacet, definePlugin } from './registry.js'

const planning = definePlugin({
  id: 'planning',
  displayName: 'Planning',
  facets: [
    defineFacet({
      name: 'due',
      displayName: 'Due',
      version: 'v0',
      targets: ['node', 'document'],
      schema: z.object({ date: z.string() }),
    }),
    defineFacet({
      name: 'assignee',
      displayName: 'Assignee',
      version: 'v0',
      targets: ['node'],
      schema: z.object({ member: z.string() }),
    }),
  ],
})

// Synthetic on both sides. The engine must not know which plugins exist —
// a test built on the bundled one reads its declaration as if it were the
// engine's behaviour, and would have to change whenever that plugin does.
const styling = definePlugin({
  id: 'styling',
  displayName: 'Styling',
  facets: [
    defineFacet({
      name: 'shape',
      displayName: 'Shape',
      version: 'v0',
      targets: ['node'],
      schema: z.object({ kind: z.string() }),
    }),
    defineFacet({
      name: 'edges',
      displayName: 'Edges',
      version: 'v0',
      targets: ['canvas'],
      schema: z.object({ routing: z.string() }),
    }),
  ],
})

const registry = createFacetRegistry([styling, planning])

describe('resolveFacetContributions', () => {
  it('groups a point by namespace in id order, facets in name order, headed by displayName', () => {
    const groups = resolveFacetContributions(registry, 'inspector.node')
    expect(groups.map((g) => g.namespace)).toEqual(['planning', 'styling'])
    expect(groups.map((g) => g.displayName)).toEqual(['Planning', 'Styling'])
    expect(groups[0]?.facets.map((f) => f.key)).toEqual(['planning.assignee/v0', 'planning.due/v0'])
    expect(groups[1]?.facets.map((f) => f.key)).toEqual(['styling.shape/v0'])
  })

  it('a point only carries facets whose targets include its object', () => {
    const canvas = resolveFacetContributions(registry, 'canvasSettings')
    expect(canvas.map((g) => g.namespace)).toEqual(['styling'])
    expect(canvas[0]?.facets.map((f) => f.key)).toEqual(['styling.edges/v0'])
  })

  it('a plugin contributing nothing to a point produces no empty group', () => {
    const canvas = resolveFacetContributions(registry, 'canvasSettings')
    expect(canvas.some((g) => g.namespace === 'planning')).toBe(false)
  })

  it('each contribution carries its definition, so a vessel can read targets and schema', () => {
    const groups = resolveFacetContributions(registry, 'inspector.node')
    const shape = groups.find((g) => g.namespace === 'styling')?.facets[0]
    expect(shape?.definition.name).toBe('shape')
    expect(shape?.definition.targets).toContain('node')
  })
})

describe('plugin displayName', () => {
  it('definePlugin rejects a blank displayName', () => {
    expect(() => definePlugin({ id: 'blank', displayName: '  ', facets: [] })).toThrow(
      /displayName/,
    )
  })

  it('carries the plugin displayName through to the group heading', () => {
    const groups = resolveFacetContributions(registry, 'canvasSettings')
    expect(groups[0]?.displayName).toBe('Styling')
  })
})
