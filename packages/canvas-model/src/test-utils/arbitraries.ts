import type { MdastNode } from '../mdast/index.js'
import { fc } from './fast-check.js'

const CROCKFORD_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID_FIRST_CHARS = '01234567'

/** Generates canonical ULIDs: first char restricted to 0-7 (see ids.ts). */
export const canonicalUlidArbitrary: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...ULID_FIRST_CHARS.split('')),
    fc.array(fc.constantFrom(...CROCKFORD_CHARS.split('')), { minLength: 25, maxLength: 25 }),
  )
  .map(([first, rest]) => first + rest.join(''))

const nodeIdArbitrary: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 24 })

export const canvasMetaArbitrary = fc.record({
  format: fc.constantFrom('markdown' as const, 'spatial' as const),
  schemaVersion: fc.constant(1 as const),
})

export const coreFacetsArbitrary = fc.record(
  {
    type: fc.string({ minLength: 1, maxLength: 20 }),
    title: fc.string({ maxLength: 40 }),
    tags: fc.array(fc.string({ maxLength: 10 }), { maxLength: 5 }),
    view: fc.string({ maxLength: 20 }),
  },
  { requiredKeys: ['type'] },
)

const domainArbitrary = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,9}$/)
  .filter((domain) => /^[a-z]/.test(domain))
const versionArbitrary = fc.integer({ min: 0, max: 99 }).map((n) => String(n))

const extensionFacetKeyArbitrary: fc.Arbitrary<string> = fc
  .tuple(domainArbitrary, versionArbitrary)
  .map(([domain, version]) => `${domain}/${version}`)

export const extensionFacetsArbitrary = fc.dictionary(extensionFacetKeyArbitrary, fc.jsonValue(), {
  maxKeys: 4,
})

const RESERVED_ROOT_KEYS = ['type', 'title', 'tags', 'view', 'facets'] as const

const facetsRawKeyArbitrary: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 15 })
  .filter((key) => !(RESERVED_ROOT_KEYS as readonly string[]).includes(key))

export const facetsRawArbitrary = fc.dictionary(facetsRawKeyArbitrary, fc.jsonValue(), {
  maxKeys: 4,
})

const geometryArbitrary = fc.integer({ min: -10_000, max: 10_000 })
const canvasColorArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('1', '2', '3', '4', '5', '6'),
  fc
    .array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 6, maxLength: 6 })
    .map((chars) => `#${chars.join('')}`),
)

const sharedNodeGeometryArbitrary = {
  id: nodeIdArbitrary,
  x: geometryArbitrary,
  y: geometryArbitrary,
  width: geometryArbitrary,
  height: geometryArbitrary,
  color: fc.option(canvasColorArbitrary, { nil: undefined }),
}

const spatialTextNodeArbitrary = fc.record({
  ...sharedNodeGeometryArbitrary,
  type: fc.constant('text' as const),
  text: fc.string({ maxLength: 50 }),
})

const spatialFileNodeArbitrary = fc.record({
  ...sharedNodeGeometryArbitrary,
  type: fc.constant('file' as const),
  file: fc.string({ minLength: 1, maxLength: 30 }),
})

const spatialLinkNodeArbitrary = fc.record({
  ...sharedNodeGeometryArbitrary,
  type: fc.constant('link' as const),
  url: fc.webUrl(),
})

const spatialGroupNodeArbitrary = fc.record({
  ...sharedNodeGeometryArbitrary,
  type: fc.constant('group' as const),
})

export const spatialNodeArbitrary = fc.oneof(
  spatialTextNodeArbitrary,
  spatialFileNodeArbitrary,
  spatialLinkNodeArbitrary,
  spatialGroupNodeArbitrary,
)

export const canvasEdgeArbitrary = fc.record({
  id: nodeIdArbitrary,
  fromNode: nodeIdArbitrary,
  toNode: nodeIdArbitrary,
  color: fc.option(canvasColorArbitrary, { nil: undefined }),
})

const xWhiteboardFreehandArbitrary = fc.record({
  kind: fc.constant('freehand' as const),
  points: fc.array(
    fc.tuple(
      fc.float({ noNaN: true, noDefaultInfinity: true }),
      fc.float({ noNaN: true, noDefaultInfinity: true }),
    ),
    { minLength: 2, maxLength: 6 },
  ),
})

const xWhiteboardShapeArbitrary = fc.record({
  kind: fc.constant('shape' as const),
  shape: fc.constantFrom('rectangle' as const, 'ellipse' as const, 'diamond' as const),
})

const xWhiteboardEmbedArbitrary = fc.record({
  kind: fc.constant('embed' as const),
  canvasId: canonicalUlidArbitrary,
})

export const xWhiteboardArbitrary = fc.oneof(
  xWhiteboardFreehandArbitrary,
  xWhiteboardShapeArbitrary,
  xWhiteboardEmbedArbitrary,
)

export const markdownCanvasArbitrary = fc.record({ body: fc.string({ maxLength: 200 }) })

const segmentArbitrary: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((segment) => !segment.includes('/'))

export const workspaceTreeNodeDataArbitrary = fc.record({
  canvasId: canonicalUlidArbitrary,
  segment: segmentArbitrary,
})

export const workspaceMetaArbitrary = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 15 }),
  fc.jsonValue(),
  {
    maxKeys: 4,
  },
)

const mdastTextLeafArbitrary: fc.Arbitrary<MdastNode> = fc
  .string({ maxLength: 20 })
  .map((value) => ({ type: 'text', value }))

/**
 * Bounded-depth mdast tree generator. `maxDepth` guards fast-check's own
 * recursion (and the parser's) from unbounded growth while still exercising
 * genuinely nested structures.
 */
export function mdastNodeArbitrary(maxDepth = 4): fc.Arbitrary<MdastNode> {
  if (maxDepth <= 0) return mdastTextLeafArbitrary

  const childArbitrary = mdastNodeArbitrary(maxDepth - 1)
  const childrenArbitrary = fc.array(childArbitrary, { minLength: 0, maxLength: 3 })

  return fc.oneof(
    { weight: 1, arbitrary: mdastTextLeafArbitrary },
    {
      weight: 1,
      arbitrary: childrenArbitrary.map(
        (children) => ({ type: 'paragraph', children }) as MdastNode,
      ),
    },
    {
      weight: 1,
      arbitrary: childrenArbitrary.map(
        (children) => ({ type: 'blockquote', children }) as MdastNode,
      ),
    },
    {
      weight: 1,
      arbitrary: canonicalUlidArbitrary.map(
        (canvasId) => ({ type: 'embed', canvasId }) as MdastNode,
      ),
    },
  )
}
