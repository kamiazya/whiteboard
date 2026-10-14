import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type CensusFacet, censusSpatialModel, jsonSchemaLeafPaths } from './census.js'

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

  it('names every field position the model can hold', () => {
    expect(census.paths).toContain('nodes[].x')
    // An edge's end is a node and nothing else since ADR-0038 decision 2.
    expect(census.paths).toContain('edges[].from.node')
    // BOTH arms of a LINE's end union, which is where the choice now lives:
    // the census's whole job on a union is to report the positions a document
    // can hold across every branch, and a walk that stopped at the first arm
    // would under-report the model by exactly the arm that makes ink ink.
    expect(census.paths).toContain('lines[].from.node')
    expect(census.paths).toContain('lines[].from.point.x')
    expect(census.paths).toContain('comments[].text')
    expect(census.paths).toContain('nodes[].embed.documentId')
  })

  it("does not classify — what a position costs an export is the ledger's answer", () => {
    // It used to split its answer by whether a path was spelled under
    // `x-whiteboard`, which only worked while the model WAS the format.
    expect(census.paths.some((path) => path.includes('x-whiteboard'))).toBe(false)
  })

  it('leaves the facet buckets unexpanded when no plugin is supplied', () => {
    expect(census.facetBuckets).toEqual([
      'edges[].facets/*',
      'facets/*',
      'lines[].facets/*',
      'nodes[].facets/*',
    ])
    expect(census.facet).toEqual([])
  })

  it('expands a facet under every spatial site it targets, and no other', () => {
    const expanded = censusSpatialModel([
      { key: 'demo.pin/v0', targets: ['node', 'document'], schema: z.object({ at: z.number() }) },
    ])
    expect(expanded.facet).toEqual(['nodes[].facets["demo.pin/v0"].at'])
  })

  // A facet bucket no target reaches is a position the census never expands,
  // so whatever a facet holds there is missing from the model's reach.
  it('reaches every facet bucket the model holds from some target', () => {
    const everyTarget = Object.keys({
      document: true,
      canvas: true,
      node: true,
      edge: true,
    } satisfies Record<CensusFacet['targets'][number], true>) as CensusFacet['targets'][number][]
    const expanded = censusSpatialModel([
      { key: 'demo.pin/v0', targets: everyTarget, schema: z.object({ at: z.number() }) },
    ])
    const reached = expanded.facet.map((path) => `${path.slice(0, path.indexOf('["'))}/*`)
    expect(expanded.facetBuckets.length).toBeGreaterThan(3)
    expect([...new Set(reached)].sort()).toEqual(expanded.facetBuckets)
  })

  it('places an edge-target facet on lines as well as edges, since a line is ink in the edge slot', () => {
    const expanded = censusSpatialModel([
      { key: 'demo.ink/v0', targets: ['edge'], schema: z.object({ group: z.string() }) },
    ])
    expect(expanded.facet).toEqual([
      'edges[].facets["demo.ink/v0"].group',
      'lines[].facets["demo.ink/v0"].group',
    ])
  })
})
