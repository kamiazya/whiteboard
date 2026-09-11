import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { censusSpatialModel, jsonSchemaLeafPaths } from './census.js'

describe('jsonSchemaLeafPaths', () => {
  it('names every leaf of a nested object, descending arrays and optionals', () => {
    const schema = z.object({
      id: z.string(),
      box: z.object({ x: z.number(), y: z.number() }),
      tags: z.array(z.string()),
      points: z.array(z.object({ x: z.number() })),
      note: z.string().optional(),
    })
    expect(jsonSchemaLeafPaths(schema)).toEqual([
      'box.x',
      'box.y',
      'id',
      'note',
      'points[].x',
      'tags[]',
    ])
  })

  it('merges a discriminated union into the set of paths any branch can hold', () => {
    const schema = z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({ type: z.literal('link'), url: z.string() }),
    ])
    expect(jsonSchemaLeafPaths(schema)).toEqual(['text', 'type', 'url'])
  })

  it('reports an open record as one unbounded bucket rather than descending it', () => {
    const schema = z.object({ facets: z.record(z.string(), z.unknown()) })
    expect(jsonSchemaLeafPaths(schema)).toEqual(['facets/*'])
  })
})

describe('censusSpatialModel', () => {
  const census = censusSpatialModel([])

  it('puts JSON Canvas 1.0 fields on the standard side', () => {
    expect(census.standard).toContain('nodes[].x')
    expect(census.standard).toContain('edges[].fromNode')
    expect(census.standard).not.toContain('nodes[].x-whiteboard.kind')
  })

  it('puts everything under x-whiteboard on the extension side', () => {
    expect(census.extension).toContain('x-whiteboard.comments[].text')
    expect(census.extension).toContain('nodes[].x-whiteboard.documentId')
    expect(census.extension.every((path) => path.includes('x-whiteboard'))).toBe(true)
  })

  it('leaves the facet buckets unexpanded when no plugin is supplied', () => {
    expect(census.facetBuckets).toEqual([
      'edges[].x-whiteboard.facets/*',
      'nodes[].x-whiteboard.facets/*',
      'x-whiteboard.facets/*',
    ])
    expect(census.facet).toEqual([])
  })

  it('expands a facet under every spatial site it targets, and no other', () => {
    const expanded = censusSpatialModel([
      { key: 'demo.pin/v0', targets: ['node', 'document'], schema: z.object({ at: z.number() }) },
    ])
    expect(expanded.facet).toEqual(['nodes[].x-whiteboard.facets["demo.pin/v0"].at'])
  })
})
