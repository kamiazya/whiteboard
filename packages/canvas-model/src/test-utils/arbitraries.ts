import { RESERVED_ROOT_KEYS } from '../facets.js'
import type {
  MdastCellPhrasingContent,
  MdastFlowContent,
  MdastListItem,
  MdastPhrasingContent,
  MdastRoot,
  MdastTableCell,
  MdastTableRow,
} from '../mdast/index.js'
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

/** Valid-by-construction arbitrary for `issueFacetPayloadSchema` (issue/1 domain). */
export const issueFacetPayloadArbitrary = fc.record(
  {
    status: fc.string({ minLength: 1, maxLength: 20 }),
    priority: fc.string({ maxLength: 20 }),
    assignees: fc.array(fc.string({ maxLength: 20 }), { maxLength: 5 }),
    labels: fc.array(fc.string({ maxLength: 20 }), { maxLength: 5 }),
    due: fc
      .date({ min: new Date(0), max: new Date(4102444800000), noInvalidDate: true })
      .map((d) => d.toISOString()),
    summary: fc.string({ maxLength: 100 }),
  },
  { requiredKeys: ['status'] },
)

const domainArbitrary = fc.stringMatching(/^[a-z][a-z0-9-]{0,9}$/)
const versionArbitrary = fc.integer({ min: 0, max: 99 }).map((n) => String(n))

const extensionFacetKeyArbitrary: fc.Arbitrary<string> = fc
  .tuple(domainArbitrary, versionArbitrary)
  .map(([domain, version]) => `${domain}/${version}`)

export const extensionFacetsArbitrary = fc.dictionary(extensionFacetKeyArbitrary, fc.jsonValue(), {
  maxKeys: 4,
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

export const facetsRawArbitrary = fc.dictionary(facetsRawKeyArbitrary, fc.jsonValue(), {
  maxKeys: 4,
})

/** Valid-by-construction arbitrary for `canvasCoreMetaSchema`: core facets plus facetsRaw. */
export const canvasCoreMetaArbitrary = fc
  .tuple(coreFacetsArbitrary, fc.option(facetsRawArbitrary, { nil: undefined }))
  .map(([core, facetsRaw]) => (facetsRaw === undefined ? core : { ...core, facetsRaw }))

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

export const xWhiteboardArbitrary = fc.record({
  kind: fc.constant('embed' as const),
  canvasId: canonicalUlidArbitrary,
})

export const markdownCanvasArbitrary = fc.record({ body: fc.string({ maxLength: 200 }) })

const segmentArbitrary: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((segment) => !segment.includes('/') && segment !== '.' && segment !== '..')

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
const wikiLinkLeafArbitrary = fc
  .record({
    canvasId: canonicalUlidArbitrary,
    alias: fc.option(fc.string({ maxLength: 10 }), { nil: undefined }),
  })
  .map(({ canvasId, alias }) => ({ type: 'wikiLink' as const, canvasId, alias }))
const embedLeafArbitrary = canonicalUlidArbitrary.map((canvasId) => ({
  type: 'embed' as const,
  canvasId,
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
