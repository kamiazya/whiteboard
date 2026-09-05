import type { AnnotationAnchor, CommentMessage, CommentThread } from '../annotation.js'
import { RESERVED_ROOT_KEYS } from '../facets.js'
import { DOCUMENT_PATH_SEGMENT_PATTERN } from '../ids.js'
import type {
  MdastCellPhrasingContent,
  MdastFlowContent,
  MdastListItem,
  MdastPhrasingContent,
  MdastRoot,
  MdastTableCell,
  MdastTableRow,
} from '../mdast/index.js'
import type { CanvasComment, CanvasEdge, SpatialCanvas } from '../spatial.js'
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
 * here in a comment.
 */
export const workspaceSegmentArbitrary: fc.Arbitrary<string> = fc
  .oneof(
    { weight: 3, arbitrary: rawWorkspaceSegmentArbitrary },
    { weight: 1, arbitrary: ulidShapedCandidateArbitrary },
  )
  .filter((segment) => !ULID_SHAPE_PATTERN.test(segment))

export const documentKindArbitrary = fc.constantFrom('markdown' as const, 'spatial' as const)

export const coreFacetsArbitrary = fc.record(
  {
    type: fc.string({ minLength: 1, maxLength: 20 }),
    title: fc.string({ maxLength: 40 }),
    tags: fc.array(fc.string({ maxLength: 10 }), { maxLength: 5 }),
    view: fc.string({ maxLength: 20 }),
  },
  { requiredKeys: ['type'] },
)

// Namespace = owning plugin id, name = the facet within it (ADR-0013).
const facetSegmentArbitrary = fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/)
const facetVersionArbitrary = fc.integer({ min: 0, max: 99 }).map((n) => `v${n}`)

const extensionFacetKeyArbitrary: fc.Arbitrary<string> = fc
  .tuple(facetSegmentArbitrary, facetSegmentArbitrary, facetVersionArbitrary)
  .map(([namespace, name, version]) => `${namespace}.${name}/${version}`)

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

export const extensionFacetsArbitrary = fc.dictionary(
  extensionFacetKeyArbitrary,
  facetValueArbitrary,
  { maxKeys: 4 },
)

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

export const facetsRawArbitrary = fc.dictionary(facetsRawKeyArbitrary, facetValueArbitrary, {
  maxKeys: 4,
})

const geometryArbitrary = fc.integer({ min: -10_000, max: 10_000 })
const sizeArbitrary = fc.integer({ min: 0, max: 10_000 })
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
  width: sizeArbitrary,
  height: sizeArbitrary,
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

// Both variants of the node-extension union: embed (facets optional) and
// facets-only. Declared before the node arbitraries that attach it.
export const xWhiteboardArbitrary = fc.oneof(
  fc.record(
    {
      kind: fc.constant('embed' as const),
      documentId: canonicalUlidArbitrary,
      facets: extensionFacetsArbitrary,
    },
    { requiredKeys: ['kind', 'documentId'] },
  ),
  fc.record({ facets: extensionFacetsArbitrary }, { requiredKeys: [] }),
)

// Every node kind may carry the x-whiteboard extension (embed | facets-only
// union), so the property suites that consume `spatialCanvasArbitrary`
// (model's schema property, codec's round-trip and extension-contract
// properties) exercise node facets rather than being blind to the union.
const bareSpatialNodeArbitrary = fc.oneof(
  spatialTextNodeArbitrary,
  spatialFileNodeArbitrary,
  spatialLinkNodeArbitrary,
  spatialGroupNodeArbitrary,
)

export const spatialNodeArbitrary = fc
  .tuple(bareSpatialNodeArbitrary, fc.option(xWhiteboardArbitrary, { nil: undefined }))
  .map(([node, extension]) =>
    extension === undefined ? node : { ...node, 'x-whiteboard': extension },
  )

export const canvasEdgeArbitrary = fc.record({
  id: nodeIdArbitrary,
  fromNode: nodeIdArbitrary,
  toNode: nodeIdArbitrary,
  color: fc.option(canvasColorArbitrary, { nil: undefined }),
})

export const markdownCanvasArbitrary = fc.record({ body: fc.string({ maxLength: 200 }) })

// ---------------------------------------------------------------------------
// mdast content-model arbitraries. Valid-by-construction: each function only
// ever generates a tree that is legal under the matching category schema in
// ../mdast/index.ts (phrasing/cellPhrasing/flow/listItem/tableRow/tableCell/
// root). `maxDepth` guards fast-check's own recursion (and the parser's)
// from unbounded growth while still exercising genuinely nested structures.
// ---------------------------------------------------------------------------

const optionalNullableString = fc.option(fc.string({ maxLength: 10 }), { nil: null })
const referenceTypeArbitrary = fc.constantFrom(
  'shortcut' as const,
  'collapsed' as const,
  'full' as const,
)

// These leaf arbitraries are intentionally left untyped (no explicit
// fc.Arbitrary<MdastPhrasingContent> annotation): they have no `children`
// field, so their inferred literal shapes are structurally assignable to
// BOTH MdastPhrasingContent and MdastCellPhrasingContent's matching
// variants. Annotating them with the wider union type would make TS check
// against the whole union (including children-bearing variants) and reject
// reuse from `mdastCellPhrasingContentArbitrary`.
const textLeafArbitrary = fc
  .string({ maxLength: 20 })
  .map((value) => ({ type: 'text' as const, value }))
const inlineCodeLeafArbitrary = fc
  .string({ maxLength: 20 })
  .map((value) => ({ type: 'inlineCode' as const, value }))
const breakLeafArbitrary: fc.Arbitrary<{ type: 'break' }> = fc.constant({ type: 'break' })
const htmlLeafArbitrary = fc
  .string({ maxLength: 20 })
  .map((value) => ({ type: 'html' as const, value }))
const imageLeafArbitrary = fc
  .record({ url: fc.webUrl(), title: optionalNullableString, alt: optionalNullableString })
  .map(({ url, title, alt }) => ({ type: 'image' as const, url, title, alt }))
const imageReferenceLeafArbitrary = fc
  .record({
    identifier: fc.string({ minLength: 1, maxLength: 10 }),
    label: optionalNullableString,
    referenceType: referenceTypeArbitrary,
    alt: optionalNullableString,
  })
  .map(({ identifier, label, referenceType, alt }) => ({
    type: 'imageReference' as const,
    identifier,
    label,
    referenceType,
    alt,
  }))
const inlineMathLeafArbitrary = fc
  .string({ maxLength: 20 })
  .map((value) => ({ type: 'inlineMath' as const, value }))
// `]`, `|` and `#` are the reference grammar's own delimiters, so a fragment
// holding one is an encoding ambiguity rather than content.
export const referenceFragmentArbitrary = fc.option(
  fc
    .string({ minLength: 1, maxLength: 10 })
    .filter((s) => !/[\]|#]/.test(s) && s.trim().length > 0),
  { nil: undefined },
)
const wikiLinkLeafArbitrary = fc
  .record({
    documentId: canonicalUlidArbitrary,
    alias: fc.option(fc.string({ maxLength: 10 }), { nil: undefined }),
    fragment: referenceFragmentArbitrary,
  })
  .map(({ documentId, alias, fragment }) => ({
    type: 'wikiLink' as const,
    documentId,
    alias,
    ...(fragment === undefined ? {} : { fragment }),
  }))
const embedLeafArbitrary = fc
  .record({ documentId: canonicalUlidArbitrary, fragment: referenceFragmentArbitrary })
  .map(({ documentId, fragment }) => ({
    type: 'embed' as const,
    documentId,
    ...(fragment === undefined ? {} : { fragment }),
  }))

/** Leaves shared by both PhrasingContent and TableCell's phrasing-minus-break. */
const cellPhrasingLeafArbitraries = [
  textLeafArbitrary,
  inlineCodeLeafArbitrary,
  htmlLeafArbitrary,
  imageLeafArbitrary,
  imageReferenceLeafArbitrary,
  inlineMathLeafArbitrary,
  wikiLinkLeafArbitrary,
  embedLeafArbitrary,
] as const

/** Bounded-depth PhrasingContent generator (includes `break`). */
export function mdastPhrasingContentArbitrary(maxDepth = 3): fc.Arbitrary<MdastPhrasingContent> {
  const leaves = fc.oneof(...cellPhrasingLeafArbitraries, breakLeafArbitrary)
  if (maxDepth <= 0) return leaves

  const childArbitrary = mdastPhrasingContentArbitrary(maxDepth - 1)
  const childrenArbitrary = fc.array(childArbitrary, { maxLength: 3 })

  return fc.oneof(
    leaves,
    childrenArbitrary.map((children) => ({ type: 'emphasis', children }) as const),
    childrenArbitrary.map((children) => ({ type: 'strong', children }) as const),
    fc
      .record({ url: fc.webUrl(), title: optionalNullableString, children: childrenArbitrary })
      .map(({ url, title, children }) => ({ type: 'link', url, title, children }) as const),
    fc
      .record({
        identifier: fc.string({ minLength: 1, maxLength: 10 }),
        label: optionalNullableString,
        referenceType: referenceTypeArbitrary,
        children: childrenArbitrary,
      })
      .map(
        ({ identifier, label, referenceType, children }) =>
          ({ type: 'linkReference', identifier, label, referenceType, children }) as const,
      ),
    childrenArbitrary.map((children) => ({ type: 'delete', children }) as const),
  )
}

/**
 * PhrasingContent minus `break` — mdast's TableCell content model. Not
 * imported directly outside this file; used by `mdastTableCellArbitrary`
 * below and kept top-level (rather than nested) so its recursion stays
 * bounded and easy to follow independently of its caller.
 */
function mdastCellPhrasingContentArbitrary(maxDepth = 3): fc.Arbitrary<MdastCellPhrasingContent> {
  const leaves = fc.oneof(...cellPhrasingLeafArbitraries)
  if (maxDepth <= 0) return leaves

  const childArbitrary = mdastCellPhrasingContentArbitrary(maxDepth - 1)
  const childrenArbitrary = fc.array(childArbitrary, { maxLength: 3 })

  return fc.oneof(
    leaves,
    childrenArbitrary.map((children) => ({ type: 'emphasis', children }) as const),
    childrenArbitrary.map((children) => ({ type: 'strong', children }) as const),
    fc
      .record({ url: fc.webUrl(), title: optionalNullableString, children: childrenArbitrary })
      .map(({ url, title, children }) => ({ type: 'link', url, title, children }) as const),
    fc
      .record({
        identifier: fc.string({ minLength: 1, maxLength: 10 }),
        label: optionalNullableString,
        referenceType: referenceTypeArbitrary,
        children: childrenArbitrary,
      })
      .map(
        ({ identifier, label, referenceType, children }) =>
          ({ type: 'linkReference', identifier, label, referenceType, children }) as const,
      ),
    childrenArbitrary.map((children) => ({ type: 'delete', children }) as const),
  )
}

const codeLeafArbitrary: fc.Arbitrary<MdastFlowContent> = fc
  .record({
    value: fc.string({ maxLength: 20 }),
    lang: fc.option(fc.string({ maxLength: 10 }), { nil: null }),
    meta: fc.option(fc.string({ maxLength: 10 }), { nil: null }),
  })
  .map(({ value, lang, meta }) => ({ type: 'code', value, lang, meta }))
const thematicBreakLeafArbitrary: fc.Arbitrary<MdastFlowContent> = fc.constant({
  type: 'thematicBreak',
})
const definitionLeafArbitrary: fc.Arbitrary<MdastFlowContent> = fc
  .record({
    identifier: fc.string({ minLength: 1, maxLength: 10 }),
    label: optionalNullableString,
    url: fc.webUrl(),
    title: optionalNullableString,
  })
  .map(({ identifier, label, url, title }) => ({
    type: 'definition',
    identifier,
    label,
    url,
    title,
  }))
const flowHtmlLeafArbitrary: fc.Arbitrary<MdastFlowContent> = fc
  .string({ maxLength: 20 })
  .map((value) => ({ type: 'html', value }))
const mathLeafArbitrary: fc.Arbitrary<MdastFlowContent> = fc
  .record({
    value: fc.string({ maxLength: 20 }),
    meta: fc.option(fc.string({ maxLength: 10 }), { nil: null }),
  })
  .map(({ value, meta }) => ({ type: 'math', value, meta }))

/** Bounded-depth FlowContent generator. */
export function mdastFlowContentArbitrary(maxDepth = 3): fc.Arbitrary<MdastFlowContent> {
  const leaves = fc.oneof(
    codeLeafArbitrary,
    thematicBreakLeafArbitrary,
    definitionLeafArbitrary,
    flowHtmlLeafArbitrary,
    mathLeafArbitrary,
  )
  if (maxDepth <= 0) return leaves

  const phrasingChildren = fc.array(mdastPhrasingContentArbitrary(maxDepth - 1), { maxLength: 3 })
  const flowChildren = fc.array(mdastFlowContentArbitrary(maxDepth - 1), { maxLength: 3 })
  const listItemChildren = fc.array(mdastListItemArbitrary(maxDepth - 1), { maxLength: 3 })
  const tableRowChildren = fc.array(mdastTableRowArbitrary(maxDepth - 1), { maxLength: 3 })

  return fc.oneof(
    leaves,
    phrasingChildren.map((children) => ({ type: 'paragraph', children }) as const),
    fc
      .record({
        depth: fc.constantFrom(
          1 as const,
          2 as const,
          3 as const,
          4 as const,
          5 as const,
          6 as const,
        ),
        children: phrasingChildren,
      })
      .map(({ depth, children }) => ({ type: 'heading', depth, children }) as const),
    flowChildren.map((children) => ({ type: 'blockquote', children }) as const),
    fc
      .record({
        ordered: fc.option(fc.boolean(), { nil: undefined }),
        start: fc.option(fc.nat(9), { nil: undefined }),
        spread: fc.option(fc.boolean(), { nil: undefined }),
        children: listItemChildren,
      })
      .map(
        ({ ordered, start, spread, children }) =>
          ({ type: 'list', ordered, start, spread, children }) as const,
      ),
    fc
      .record({
        align: fc.option(
          fc.array(fc.constantFrom('left' as const, 'right' as const, 'center' as const, null), {
            maxLength: 3,
          }),
          { nil: undefined },
        ),
        children: tableRowChildren,
      })
      .map(({ align, children }) => ({ type: 'table', align, children }) as const),
  )
}

/**
 * ListContent — a listItem's children are FlowContent. Not imported
 * directly outside this file; used by `mdastFlowContentArbitrary`'s `list`
 * variant.
 */
function mdastListItemArbitrary(maxDepth = 3): fc.Arbitrary<MdastListItem> {
  return fc
    .record({
      checked: fc.option(fc.boolean(), { nil: undefined }),
      spread: fc.option(fc.boolean(), { nil: undefined }),
      children: fc.array(mdastFlowContentArbitrary(maxDepth), { maxLength: 3 }),
    })
    .map(({ checked, spread, children }) => ({ type: 'listItem', checked, spread, children }))
}

/**
 * RowContent — a tableCell's children are phrasing minus `break`. Not
 * imported directly outside this file; used by `mdastTableRowArbitrary`.
 */
function mdastTableCellArbitrary(maxDepth = 3): fc.Arbitrary<MdastTableCell> {
  return fc
    .array(mdastCellPhrasingContentArbitrary(maxDepth), { maxLength: 3 })
    .map((children) => ({ type: 'tableCell', children }))
}

/** TableContent — a tableRow's children are tableCells. */
export function mdastTableRowArbitrary(maxDepth = 3): fc.Arbitrary<MdastTableRow> {
  return fc
    .array(mdastTableCellArbitrary(maxDepth), { maxLength: 3 })
    .map((children) => ({ type: 'tableRow', children }))
}

/**
 * Document root — an intentionally flow-only application subset of upstream
 * mdast Root (see ../mdast/index.ts).
 */
export function mdastRootArbitrary(maxDepth = 3): fc.Arbitrary<MdastRoot> {
  return fc
    .array(mdastFlowContentArbitrary(maxDepth), { maxLength: 3 })
    .map((children) => ({ type: 'root', children }))
}

/**
 * A SpatialCanvas that is valid by construction.
 *
 * The two invariants `spatialCanvasSchema` enforces — unique node ids, and
 * edges whose endpoints exist — cannot be met by generating nodes and edges
 * independently, so they are built in rather than filtered afterwards. Node ids
 * in particular need the explicit uniqueness: `nodeIdArbitrary` has low entropy
 * at small sizes (it shrinks to `" "`), so collisions are rare enough to pass
 * hundreds of runs and then fail on someone else's seed.
 *
 * It lives here because three packages were each building this shape by hand
 * and one of them had lost the node-id dedupe — a canvas the schema rejects,
 * asserted to round-trip.
 */
// Valid-by-construction: text is non-empty, the anchor is integer, and the
// optional author/timestamp use the shapes their schemas actually accept.
// `targetNodeId` is free-standing on purpose — a dangling target is VALID
// (a comment may outlive its subject), so the canvas arbitrary does not need
// to correlate it with node ids the way edges must be.
export const canvasCommentArbitrary: fc.Arbitrary<CanvasComment> = fc.record(
  {
    id: nodeIdArbitrary,
    x: geometryArbitrary,
    y: geometryArbitrary,
    text: fc.string({ minLength: 1, maxLength: 40 }),
    author: fc.constantFrom('human:reviewer', 'process:layout-agent'),
    createdAt: fc.constant('2026-09-01T10:00:00+09:00'),
    targetNodeId: nodeIdArbitrary,
    resolved: fc.boolean(),
  },
  { requiredKeys: ['id', 'x', 'y', 'text'] },
)

/**
 * The annotation layer's generators (ADR-0026). Valid-by-construction against
 * `annotationAnchorSchema` / `commentThreadSchema`, and deliberately covering
 * BOTH anchor arms: a property that only ever saw the spatial arm would say
 * nothing about the shape's whole reason for existing.
 */
export const annotationAnchorArbitrary: fc.Arbitrary<AnnotationAnchor> = fc.oneof(
  fc.record(
    {
      kind: fc.constant('spatial' as const),
      nodeId: nodeIdArbitrary,
      x: geometryArbitrary,
      y: geometryArbitrary,
    },
    { requiredKeys: ['kind', 'x', 'y'] },
  ),
  fc
    .record(
      {
        kind: fc.constant('text' as const),
        quote: fc.record(
          {
            prefix: fc.string({ maxLength: 8 }),
            exact: fc.string({ minLength: 1, maxLength: 24 }),
            suffix: fc.string({ maxLength: 8 }),
          },
          { requiredKeys: ['exact'] },
        ),
        start: fc.nat({ max: 4000 }),
        length: fc.nat({ max: 200 }),
      },
      { requiredKeys: ['kind', 'quote', 'start', 'length'] },
    )
    // `end` is derived rather than generated so the range is never backwards —
    // the schema rejects that, and a filter would just discard half the runs.
    .map(({ length, ...anchor }) => ({ ...anchor, end: anchor.start + length })),
)

export const commentMessageArbitrary: fc.Arbitrary<CommentMessage> = fc.record(
  {
    id: nodeIdArbitrary,
    body: fc.string({ minLength: 1, maxLength: 40 }),
    author: fc.constantFrom('human:reviewer', 'process:layout-agent'),
    createdAt: fc.constantFrom(
      '2026-09-01T10:00:00+09:00',
      '2026-09-01T11:30:00Z',
      '2026-09-02T09:15:00Z',
    ),
  },
  { requiredKeys: ['id', 'body'] },
)

export const commentThreadArbitrary: fc.Arbitrary<CommentThread> = fc.record(
  {
    id: nodeIdArbitrary,
    anchor: annotationAnchorArbitrary,
    status: fc.constantFrom('open' as const, 'resolved' as const),
    createdAt: fc.constant('2026-09-01T10:00:00+09:00'),
    // Unique ids for the same reason the canvas arbitrary dedupes node ids:
    // `nodeIdArbitrary` collides often enough at small sizes to pass hundreds
    // of runs and then fail on someone else's seed, and a thread whose two
    // messages share an id is not a thread the storage can represent.
    messages: fc.uniqueArray(commentMessageArbitrary, {
      minLength: 1,
      maxLength: 4,
      selector: (message) => message.id,
    }),
  },
  { requiredKeys: ['id', 'anchor', 'status', 'messages'] },
)

export const spatialCanvasArbitrary: fc.Arbitrary<SpatialCanvas> = fc
  .uniqueArray(spatialNodeArbitrary, { maxLength: 4, selector: (node) => node.id })
  .chain((nodes) => {
    const ids = nodes.map((node) => node.id)
    if (ids.length < 2) return fc.constant({ nodes, edges: [] as CanvasEdge[] })
    return fc
      .uniqueArray(
        fc
          .tuple(fc.constantFrom(...ids), fc.constantFrom(...ids))
          .chain(([fromNode, toNode]) =>
            canvasEdgeArbitrary.map((edge) => ({ ...edge, fromNode, toNode })),
          ),
        { maxLength: 3, selector: (edge) => edge.id },
      )
      .map((edges) => ({ nodes, edges }))
  })
  .chain(
    (canvas): fc.Arbitrary<SpatialCanvas> =>
      fc
        .option(fc.uniqueArray(canvasCommentArbitrary, { maxLength: 3, selector: (c) => c.id }), {
          nil: undefined,
        })
        .map((comments) =>
          comments === undefined || comments.length === 0
            ? canvas
            : { ...canvas, 'x-whiteboard': { comments } },
        ),
  )
