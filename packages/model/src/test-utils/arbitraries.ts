/**
 * The shared generators over model's schemas, drawn FROM the schemas.
 *
 * Each arbitrary below is `arbitraryForSchema` over the schema it stands
 * for, so a field added to the schema tomorrow — an edge's `label`, a
 * group's `background`, the canvas-level `facets` bucket — is drawn by
 * every property without anyone extending a hand-written mirror. This file
 * used to BE that mirror, and it had drifted: the node generator knew no
 * `subpath`, no `label`, no `versionRef`; the edge generator knew no side,
 * end or label; the canvas generator drew comments and nothing else at the
 * canvas level, so every round-trip property over a canvas was blind to
 * `edgeRouting` and to the canvas's own facets.
 *
 * What stays hand-written is what a schema cannot say: the correlations
 * (an edge's endpoints name nodes that exist, ids are unique across a
 * collection), the value domains a filter would waste most draws on (a
 * facet key's grammar, a yaml-safe facet value), and the one adversarial
 * weighting (`workspaceSegmentArbitrary`) that exists to keep a mutated
 * exclusion filter from passing vacuously.
 */

import type { z } from 'zod'
import { annotationAnchorSchema, commentMessageSchema, commentThreadSchema } from '../annotation.js'
import { documentKindSchema } from '../document-kind.js'
import {
  coreFacetsSchema,
  EXTENSION_FACET_KEY_PATTERN,
  extensionFacetsSchema,
  facetsRawSchema,
  RESERVED_ROOT_KEYS,
} from '../facets.js'
import { DOCUMENT_PATH_SEGMENT_PATTERN, documentIdSchema } from '../ids.js'
import { markdownDocumentSchema } from '../markdown.js'
import {
  mdastFlowContentSchema,
  mdastPhrasingContentSchema,
  mdastRootSchema,
  mdastTableRowSchema,
} from '../mdast/index.js'
import {
  type CanvasEdge,
  canvasCommentSchema,
  canvasEdgeSchema,
  canvasExtensionSchema,
  type SpatialCanvas,
  spatialNodeSchema,
  xWhiteboardSchema,
} from '../spatial.js'
import { okfActorSchema } from '../trust.js'
import { fc } from './fast-check.js'
import { arbitraryForSchema, type SchemaArbitraryOptions, sameSchema } from './zod-arbitrary.js'

const CROCKFORD_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID_FIRST_CHARS = '01234567'

/** Canonical ULIDs, drawn from `documentIdSchema`'s own pattern. */
export const canonicalUlidArbitrary: fc.Arbitrary<string> = arbitraryForSchema(documentIdSchema)

// Mirrors workspaceSegmentSchema's own `.refine` (ids.ts): a canonical ULID
// is exactly 26 Crockford base32 chars with a leading [0-7], matched
// case-insensitively since Crockford decoding ignores case. Duplicated here
// rather than imported because ULID_PATTERN is private to ids.ts — this
// generator-side copy exists only to steer the arbitrary away from the
// shape the schema itself rejects, not to define the contract.
const ULID_SHAPE_PATTERN = new RegExp(`^[${ULID_FIRST_CHARS}][${CROCKFORD_CHARS}]{25}$`, 'i')

// Ordinary segment shape, generated straight from the schema's own exported
// grammar so the two cannot drift.
const rawWorkspaceSegmentArbitrary: fc.Arbitrary<string> = fc.stringMatching(
  DOCUMENT_PATH_SEGMENT_PATTERN,
)

// Deliberately mixed in at meaningful weight (not left to arise by chance
// from the grammar above, which would make a mutated exclusion filter pass
// vacuously): candidates shaped exactly like a canonical ULID, upper- and
// lower-cased, so the exclusion filter below is actually exercised.
const ulidShapedCandidateArbitrary: fc.Arbitrary<string> = fc
  .tuple(canonicalUlidArbitrary, fc.boolean())
  .map(([ulid, lower]) => (lower ? ulid.toLowerCase() : ulid))

/**
 * Generates workspace segments valid-by-construction against
 * `workspaceSegmentSchema` (ADR-0019): the document-path-segment grammar,
 * with the schema's own ULID-shape disjointness refinement re-applied as a
 * generator-side filter. Its "valid-by-construction" claim is pinned by the
 * generator-validity property in `properties.test.ts`, not merely asserted
 * here in a comment. Kept hand-written on purpose: the schema-derived draw
 * would reach a ULID-shaped candidate so rarely that a mutated exclusion
 * filter passes vacuously.
 */
export const workspaceSegmentArbitrary: fc.Arbitrary<string> = fc
  .oneof(
    { weight: 3, arbitrary: rawWorkspaceSegmentArbitrary },
    { weight: 1, arbitrary: ulidShapedCandidateArbitrary },
  )
  .filter((segment) => !ULID_SHAPE_PATTERN.test(segment))

export const documentKindArbitrary = arbitraryForSchema(documentKindSchema)

export const coreFacetsArbitrary = arbitraryForSchema(coreFacetsSchema)

/**
 * `fc.jsonValue()` can place an own `__proto__` key inside a generated
 * object, and that is legitimate JSON — `JSON.parse` defines it as an own
 * property rather than touching the prototype. Nothing downstream can carry
 * it: facet values reach storage through the Loro WASM boundary, which
 * reconstructs plain objects without that key, so any preservation property
 * over such a value is unsatisfiable. Narrow the generator rather than teach
 * a parser to reproduce the key — the same call the `facetsRaw` key filter
 * below makes, one nesting level down.
 */
function stripProtoKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripProtoKeys)
  // Negative zero is legal JS but not a JSON-text value: JSON.stringify(-0)
  // emits "0" and JSON.parse never yields -0, so a facet value holding one
  // cannot round-trip through ANY JSON-text codec. Normalize at generation
  // — the same call as the __proto__ strip below (narrow the generator,
  // never teach a parser to reproduce the unreachable value).
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__') continue
    out[key] = stripProtoKeys(child)
  }
  return out
}

const facetValueArbitrary = fc.jsonValue().map(stripProtoKeys)

/**
 * The extension bucket's keys follow a grammar the schema states as a
 * refinement over `z.record(z.string(), …)`; drawn from the pattern itself
 * rather than left to the filter, which would reject every random key.
 */
export const extensionFacetsArbitrary = arbitraryForSchema(extensionFacetsSchema, {
  override: (path) => {
    if (path.endsWith('{key}')) return fc.stringMatching(EXTENSION_FACET_KEY_PATTERN)
    if (path.endsWith('{}')) return facetValueArbitrary
    return undefined
  },
})

const facetsRawKeyArbitrary: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 15 })
  .filter((key) => !(RESERVED_ROOT_KEYS as readonly string[]).includes(key))
  // `__proto__` is excluded because Zod deliberately skips it when building
  // the parsed object, so it can never round-trip and the preservation
  // property cannot hold for it. Keeping that skip matters: a consumer that
  // merges parsed facets with `Object.assign` or a `for (k) out[k] = ...`
  // loop invokes the `__proto__` setter and pollutes the target's prototype.
  // So the property is narrowed rather than the schema widened to carry the
  // key; `facets.test.ts` pins the skip as deliberate behaviour.
  .filter((key) => key !== '__proto__')

export const facetsRawArbitrary = arbitraryForSchema(facetsRawSchema, {
  override: (path) => {
    if (path.endsWith('{key}')) return facetsRawKeyArbitrary
    if (path.endsWith('{}')) return facetValueArbitrary
    return undefined
  },
})

/**
 * OKF actors: `human:` is the one prefix that carries meaning (trust tiers
 * key off it), so it is drawn at real weight beside what the schema alone
 * would accept.
 */
const okfActorArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('human:reviewer', 'process:layout-agent'),
  arbitraryForSchema(okfActorSchema),
)

/**
 * The substitutions every schema-derived generator here shares, matched by
 * schema IDENTITY so they apply wherever the schema is composed: a facets
 * bucket draws its grammar, an actor draws the `human:` prefix at weight.
 */
const sharedOverrides: SchemaArbitraryOptions['override'] = (_path, schema) => {
  if (sameSchema(schema, extensionFacetsSchema)) return extensionFacetsArbitrary
  if (sameSchema(schema, okfActorSchema)) return okfActorArbitrary
  return undefined
}

export const xWhiteboardArbitrary = arbitraryForSchema(xWhiteboardSchema, {
  override: sharedOverrides,
})

export const spatialNodeArbitrary = arbitraryForSchema(spatialNodeSchema, {
  override: sharedOverrides,
})

export const canvasEdgeArbitrary = arbitraryForSchema(canvasEdgeSchema)

export const markdownCanvasArbitrary = arbitraryForSchema(markdownDocumentSchema, {
  // A body long enough for a property about text to reach something.
  override: (path) => (path === '$.body' ? fc.string({ maxLength: 200 }) : undefined),
})

// ---------------------------------------------------------------------------
// mdast content-model arbitraries, drawn from the recursive schemas in
// ../mdast/index.ts. `maxDepth` is how many times a category may nest inside
// itself; at the ceiling the walk keeps the union arms and the empty arrays
// that need no further expansion, so a tree is always finite.
// ---------------------------------------------------------------------------

// `]`, `|` and `#` are the reference grammar's own delimiters, so a fragment
// holding one is an encoding ambiguity rather than content.
const referenceFragmentTextArbitrary = fc
  .string({ minLength: 1, maxLength: 10 })
  .filter((s) => !/[\]|#]/.test(s) && s.trim().length > 0)
export const referenceFragmentArbitrary = fc.option(referenceFragmentTextArbitrary, {
  nil: undefined,
})

const mdastOverrides: SchemaArbitraryOptions['override'] = (path) =>
  path.endsWith('.fragment') ? referenceFragmentTextArbitrary : undefined

function mdastArbitrary<T>(schema: z.ZodType<T>) {
  const byDepth = new Map<number, fc.Arbitrary<T>>()
  return (maxDepth = 3): fc.Arbitrary<T> => {
    const known = byDepth.get(maxDepth)
    if (known !== undefined) return known
    const built = arbitraryForSchema(schema, { maxDepth, override: mdastOverrides })
    byDepth.set(maxDepth, built)
    return built
  }
}

/** Bounded-depth PhrasingContent generator (includes `break`). */
export const mdastPhrasingContentArbitrary = mdastArbitrary(mdastPhrasingContentSchema)

/** Bounded-depth FlowContent generator. */
export const mdastFlowContentArbitrary = mdastArbitrary(mdastFlowContentSchema)

/** TableContent — a tableRow's children are tableCells. */
export const mdastTableRowArbitrary = mdastArbitrary(mdastTableRowSchema)

/**
 * Document root — an intentionally flow-only application subset of upstream
 * mdast Root (see ../mdast/index.ts).
 */
export const mdastRootArbitrary = mdastArbitrary(mdastRootSchema)

/**
 * A canvas comment as the schema accepts it. `targetNodeId` is free-standing
 * on purpose — a dangling target is VALID (a comment may outlive its
 * subject), so the canvas arbitrary does not need to correlate it with node
 * ids the way edges must be.
 */
export const canvasCommentArbitrary = arbitraryForSchema(canvasCommentSchema, {
  override: sharedOverrides,
})

/**
 * The annotation layer's generators (ADR-0026), drawn from the schemas. The
 * anchor's three refinements — one reference at most, a node set naming
 * each node once, a region with both sides — are honoured by the schema
 * filter; `annotation.test.ts` pins that every arm and every reference is
 * still reached.
 */
export const annotationAnchorArbitrary = arbitraryForSchema(annotationAnchorSchema)

export const commentMessageArbitrary = arbitraryForSchema(commentMessageSchema, {
  override: sharedOverrides,
})

export const commentThreadArbitrary = arbitraryForSchema(commentThreadSchema, {
  override: (path, schema) => {
    // Unique ids, because a thread whose two messages share an id is not a
    // thread the storage can represent, and short ids collide often enough
    // to pass hundreds of runs and then fail on someone else's seed.
    if (path === '$.messages') {
      return fc.uniqueArray(commentMessageArbitrary, {
        minLength: 1,
        maxLength: 4,
        selector: (message) => message.id,
      })
    }
    return sharedOverrides?.(path, schema)
  },
})

/**
 * The canvas-level extension: routing preferences, comments and the
 * canvas's facets, each independently present. Comments get unique ids for
 * the same reason a thread's messages do.
 */
const canvasExtensionArbitrary = arbitraryForSchema(canvasExtensionSchema, {
  override: (path, schema) => {
    if (path === '$.comments') {
      return fc.uniqueArray(canvasCommentArbitrary, { maxLength: 3, selector: (c) => c.id })
    }
    return sharedOverrides?.(path, schema)
  },
})

/**
 * A SpatialCanvas that is valid by construction.
 *
 * The two invariants `spatialCanvasSchema` enforces — unique node ids, and
 * edges whose endpoints exist — cannot be met by generating nodes and edges
 * independently, so they are built in rather than filtered afterwards. Node
 * ids in particular need the explicit uniqueness: the schema's id is any
 * non-empty string, drawn short, so collisions are rare enough to pass
 * hundreds of runs and then fail on someone else's seed.
 *
 * It lives here because three packages were each building this shape by
 * hand and one of them had lost the node-id dedupe — a canvas the schema
 * rejects, asserted to round-trip.
 */
export const spatialCanvasArbitrary: fc.Arbitrary<SpatialCanvas> = fc
  .uniqueArray(spatialNodeArbitrary, { maxLength: 4, selector: (node) => node.id })
  .chain((nodes) => {
    const ids = nodes.map((node) => node.id)
    if (ids.length < 2) return fc.constant({ nodes, edges: [] as CanvasEdge[] })
    return fc
      .uniqueArray(
        fc
          .tuple(fc.constantFrom(...ids), fc.constantFrom(...ids), canvasEdgeArbitrary)
          .map(([fromNode, toNode, edge]) => ({ ...edge, fromNode, toNode })),
        { maxLength: 3, selector: (edge) => edge.id },
      )
      .map((edges) => ({ nodes, edges }))
  })
  .chain(
    (canvas): fc.Arbitrary<SpatialCanvas> =>
      fc
        .option(canvasExtensionArbitrary, { nil: undefined })
        .map((extension) =>
          extension === undefined ? canvas : { ...canvas, 'x-whiteboard': extension },
        ),
  )
