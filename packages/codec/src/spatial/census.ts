import { spatialCanvasSchema } from '@kamiazya/whiteboard-model'
import type { z } from 'zod'
import { z as zod } from 'zod'

type JsonSchemaNode = Record<string, unknown>

function walk(node: JsonSchemaNode, path: string, out: string[]): void {
  const branches = (node.anyOf ?? node.oneOf ?? node.allOf) as JsonSchemaNode[] | undefined
  if (Array.isArray(branches)) {
    // A union holds whichever branch's fields, so the model's reach is their
    // union — de-duplicated by the caller, since branches share a discriminator.
    for (const branch of branches) walk(branch, path, out)
    return
  }
  if (node.properties !== undefined) {
    const properties = node.properties as Record<string, JsonSchemaNode>
    for (const key of Object.keys(properties)) {
      walk(properties[key], path === '' ? key : `${path}.${key}`, out)
    }
    return
  }
  if (node.type === 'object') {
    // An open record. The format can say a bucket is there and nothing about
    // what is in it, which is the measurement, so it is one entry rather than
    // a descent that would report zero.
    out.push(`${path}/*`)
    return
  }
  if (node.type === 'array') {
    walk((node.items ?? {}) as JsonSchemaNode, `${path}[]`, out)
    return
  }
  out.push(path)
}

/**
 * Every leaf field path a schema can hold, sorted and de-duplicated. An open
 * record is reported as one `…/*` bucket: its contents are outside what the
 * schema states, and counting them as zero would read as "nothing is there".
 */
export function jsonSchemaLeafPaths(schema: z.ZodType): readonly string[] {
  const out: string[] = []
  walk(
    zod.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }) as JsonSchemaNode,
    '',
    out,
  )
  return [...new Set(out)].sort()
}

/** A facet as this census needs to read one — the shape `defineFacet` produces. */
export interface CensusFacet {
  readonly key: string
  readonly targets: readonly string[]
  readonly schema: z.ZodType
}

export interface SpatialModelCensus {
  /** Every leaf field position the model can hold, facet buckets excluded. */
  readonly paths: readonly string[]
  /** The facet buckets (`…/*`), which a format can only say are present. */
  readonly facetBuckets: readonly string[]
  /** Leaf paths inside those buckets, for the facets supplied. */
  readonly facet: readonly string[]
}

/** Where in a spatial document a facet target attaches, if anywhere. */
const SITE_PREFIX: Record<string, string> = {
  canvas: 'facets',
  node: 'nodes[].facets',
  edge: 'edges[].facets',
}

/**
 * Every field position the whiteboard's spatial model can hold.
 *
 * Total rather than sampled: it reads the schemas, so no choice of corpus can
 * flatter or damn the answer. What it cannot see is the only thing it does not
 * claim — a facet nobody passed in, which is the point of `facetBuckets`.
 *
 * It does NOT classify. It used to split its answer by whether a path was
 * spelled under `x-whiteboard`, which worked only while the model WAS the
 * format — the very thing
 * [ADR-0035](../../../../docs/contributing/adr/0035-model-and-format.md) ends.
 * What a position costs an export is now the projection ledger's answer, and
 * keeping a second one here would be two authorities on one question.
 */
export function censusSpatialModel(facets: readonly CensusFacet[]): SpatialModelCensus {
  const all = jsonSchemaLeafPaths(spatialCanvasSchema)
  const facetBuckets: string[] = []
  const paths: string[] = []
  for (const path of all) {
    // The `/*` stays on: it is the same notation the value walker and the
    // projection ledger use, and it is what marks the bucket unbounded.
    if (path.endsWith('facets/*')) facetBuckets.push(path)
    else paths.push(path)
  }
  const facet = facets.flatMap((definition) =>
    definition.targets.flatMap((target) => {
      const prefix = SITE_PREFIX[target]
      if (prefix === undefined) return []
      return jsonSchemaLeafPaths(definition.schema).map(
        (leaf) => `${prefix}["${definition.key}"].${leaf}`,
      )
    }),
  )
  return { paths, facetBuckets, facet: [...new Set(facet)].sort() }
}
