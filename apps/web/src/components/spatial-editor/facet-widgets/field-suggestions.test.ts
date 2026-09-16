import { createFacetRegistry, defineFacet, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { collectFieldSuggestions } from './field-suggestions.js'

const box = (id: string, facets?: Record<string, unknown>) =>
  textNode({
    id,
    text: id,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    ...(facets === undefined ? {} : { facets }),
  })

const registry = createFacetRegistry([
  definePlugin({
    id: 'demo',
    displayName: 'Demo',
    facets: [
      defineFacet({
        name: 'class',
        displayName: 'Class',
        version: 'v0',
        targets: ['node'],
        schema: z.object({ axis: z.string(), value: z.string() }),
      }),
      defineFacet({
        name: 'rank',
        displayName: 'Rank',
        version: 'v0',
        targets: ['node'],
        schema: z.object({ level: z.number() }),
      }),
      defineFacet({
        name: 'shape',
        displayName: 'Shape',
        version: 'v0',
        targets: ['node'],
        schema: z.object({ kind: z.enum(['ellipse', 'diamond']) }),
      }),
    ],
  }),
])

describe('collectFieldSuggestions', () => {
  it("lists each text field's distinct values across the board, sorted", () => {
    const nodes = [
      box('a', { 'demo.class/v0': { axis: 'health', value: 'failing' } }),
      box('b', { 'demo.class/v0': { axis: 'health', value: 'healthy' } }),
      box('c', { 'demo.class/v0': { axis: 'priority', value: 'high' } }),
      box('d'),
    ]
    expect(collectFieldSuggestions(nodes, registry)).toEqual({
      'demo.class/v0': {
        axis: ['health', 'priority'],
        value: ['failing', 'healthy', 'high'],
      },
    })
  })

  it('offers nothing for a number field, an enum, an unregistered key, or an empty string', () => {
    const nodes = [
      box('a', {
        'demo.rank/v0': { level: 3 },
        'demo.shape/v0': { kind: 'ellipse' },
        'other.thing/v0': { note: 'free' },
        'demo.class/v0': { axis: '', value: 'x' },
      }),
    ]
    expect(collectFieldSuggestions(nodes, registry)).toEqual({
      'demo.class/v0': { value: ['x'] },
    })
  })

  it('answers an empty record for a board with no facets at all', () => {
    expect(collectFieldSuggestions([box('a')], registry)).toEqual({})
  })
})
