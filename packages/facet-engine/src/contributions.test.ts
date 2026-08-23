// The contribution resolution layer: core surfaces ask "what does this
// point carry" and get namespace groups derived mechanically from facet
// targets — no surface ever names a plugin or facet key itself.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { resolveFacetContributions } from './contributions.js'
import { createFacetRegistry, defineFacet, definePlugin } from './registry.js'
import { visualPlugin } from './visual.js'

const planning = definePlugin({
  id: 'planning',
  displayName: 'Planning',
  facets: [
    defineFacet({
      name: 'due',
      version: 'v0',
      targets: ['node', 'document'],
      schema: z.object({ date: z.string() }),
    }),
    defineFacet({
      name: 'assignee',
      version: 'v0',
      targets: ['node'],
      schema: z.object({ member: z.string() }),
    }),
  ],
})

const registry = createFacetRegistry([visualPlugin, planning])

describe('resolveFacetContributions', () => {
  it('groups a point by namespace in id order, facets in name order, headed by displayName', () => {
    const groups = resolveFacetContributions(registry, 'contextMenu.node.properties')
    expect(groups.map((g) => g.namespace)).toEqual(['planning', 'visual'])
    expect(groups.map((g) => g.displayName)).toEqual(['Planning', 'Visual style'])
    expect(groups[0]?.facets.map((f) => f.key)).toEqual(['planning.assignee/v0', 'planning.due/v0'])
    expect(groups[1]?.facets.map((f) => f.key)).toEqual([
      'visual.shape/v0',
      'visual.symbol/v0',
      'visual.text/v0',
    ])
  })

  it('a point only carries facets whose targets include its object', () => {
    const canvas = resolveFacetContributions(registry, 'canvasSettings')
    expect(canvas.map((g) => g.namespace)).toEqual(['visual'])
    expect(canvas[0]?.facets.map((f) => f.key)).toEqual(['visual.edges/v0'])
  })

  it('a plugin contributing nothing to a point produces no empty group', () => {
    const canvas = resolveFacetContributions(registry, 'canvasSettings')
    expect(canvas.some((g) => g.namespace === 'planning')).toBe(false)
  })

  it('each contribution carries its definition, so a vessel can read targets and schema', () => {
    const groups = resolveFacetContributions(registry, 'contextMenu.node.properties')
    const shape = groups.find((g) => g.namespace === 'visual')?.facets[0]
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

  it('the bundled visual plugin names itself for humans', () => {
    expect(visualPlugin.displayName).toBe('Visual style')
  })
})
