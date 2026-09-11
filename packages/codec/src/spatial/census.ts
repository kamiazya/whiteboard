import { spatialCanvasSchema } from '@kamiazya/whiteboard-model'
import type { z } from 'zod'
import { z as zod } from 'zod'

type JsonSchemaNode = Record<string, unknown>

const EXTENSION_KEY = 'x-whiteboard'

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
  /** Leaf paths JSON Canvas 1.0 defines itself. These survive `strictDegrade`. */
  readonly standard: readonly string[]
  /** Leaf paths reachable only under `x-whiteboard`, facet buckets excluded. */
  readonly extension: readonly string[]
  /** The facet buckets (`…/*`), which the format can only say are present. */
  readonly facetBuckets: readonly string[]
  /** Leaf paths inside those buckets, for the facets supplied. */
  readonly facet: readonly string[]
}

/** Where in a spatial document a facet target attaches, if anywhere. */
const SITE_PREFIX: Record<string, string> = {
  canvas: `${EXTENSION_KEY}.facets`,
  node: `nodes[].${EXTENSION_KEY}.facets`,
  edge: `edges[].${EXTENSION_KEY}.facets`,
}

/**
 * How much of the whiteboard's spatial model JSON Canvas 1.0 states, and how
 * much of it lives in the one extension key the format leaves room for.
 *
 * Total rather than sampled: it reads the schemas, so no choice of corpus can
 * flatter or damn the answer. What it cannot see is the only thing it does not
 * claim — a facet nobody passed in, which is the point of `facetBuckets`.
 */
export function censusSpatialModel(facets: readonly CensusFacet[]): SpatialModelCensus {
  const all = jsonSchemaLeafPaths(spatialCanvasSchema)
  const facetBuckets: string[] = []
  const extension: string[] = []
  const standard: string[] = []
  for (const path of all) {
    if (!path.includes(EXTENSION_KEY)) {
      standard.push(path)
    } else if (path.endsWith('.facets/*')) {
      // The `/*` stays on: it is the same notation the value walker and the
      // projection ledger use, and it is what marks the bucket unbounded.
      facetBuckets.push(path)
    } else {
      extension.push(path)
    }
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
  return { standard, extension, facetBuckets, facet: [...new Set(facet)].sort() }
}
